/**
 * gauntlet/v1 - the execution-graph contract shared with the Alfred harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * Alfred owns policy, safety and memory; Ultron owns model access and portable
 * pipelines. They are deliberately separate runtimes. The contract between them is
 * this spec: one `gauntlet/v1` file must validate and route IDENTICALLY on both
 * engines.
 *
 * That matters for safety, not just convenience. The anti-thrash rule ("two
 * failures of the same approach -> change the approach") is structural in Alfred's
 * router. If Ultron executed the same graph with a plain retry loop, running a
 * spec here instead of there would silently bypass the guarantee. So the router
 * lives in both, with the same bounds, and `scripts/test_ultron_parity.py` asserts
 * the two agree.
 *
 * Mirrors scripts/gauntlet.py. Any change to the bounds below must be made in
 * both files, and the parity test will fail if they drift.
 */

export const SCHEMA = 'gauntlet/v1';

export const PASS = 'PASS';
export const RETRY = 'RETRY';
export const REROUTE = 'REROUTE';
export const ESCALATE = 'ESCALATE';
export const ABORT = 'ABORT';
export const VERDICTS = [PASS, RETRY, REROUTE, ESCALATE, ABORT];

export const ADVANCE = 'advance';
export const REMEDY = 'remedy';
export const ALTERNATIVE = 'alternative';
export const TIER_UP = 'tier_up';
export const STOP = 'stop';

export const NODE_KINDS = ['work', 'gate', 'approval'];

/** Bounds on the degradation ladder. Must match scripts/gauntlet.py exactly. */
export const MAX_SAME_REASON_RETRIES = 2;
export const MAX_SAME_REASON_REROUTES = 2;
export const MAX_SAME_REASON_ESCALATIONS = 1;

/**
 * Code-INDEPENDENT backstop on how many times one gate may reject.
 *
 * Every other bound keys on (gate, reason_code). A model that renames the same
 * failure each time therefore looks like it is reporting novel problems, the
 * per-code counters never trip, and the run spins until the budget dies. Measured
 * on a real 7B gate: 40 node runs, 19 invented codes, ZERO forced reroutes.
 * A guarantee a model can defeat by relabelling is not a guarantee.
 */
export const MAX_GATE_REJECTIONS = 4;

/**
 * The default controlled vocabulary. Codes outside the declared set are folded
 * into OTHER so distinct-looking labels cannot mask a repeated failure.
 */
export const DEFAULT_REASON_CODES = [
  'TESTS_FAILED', 'BUILD_FAILED', 'NO_EVIDENCE', 'INCOMPLETE',
  'WRONG_APPROACH', 'STYLE_VIOLATION', 'UNSAFE', 'NEEDS_HUMAN', 'OTHER',
];

/** Fold unrecognised reason codes into OTHER, keeping the original as detail. */
export function normalizeVerdict(verdict, allowed = DEFAULT_REASON_CODES) {
  if (!allowed || !allowed.length) return verdict;
  const permitted = new Set(allowed.map(c => c.toUpperCase()));
  let changed = false;
  const reasons = (verdict.reasons || []).map(reason => {
    const code = String(reason.code || '').toUpperCase();
    if (permitted.has(code)) return reason;
    changed = true;
    return { code: 'OTHER', detail: `${reason.code}: ${reason.detail || ''}`.replace(/: $/, '').slice(0, 300) };
  });
  return changed ? { ...verdict, reasons } : verdict;
}

export const isGauntletSpec = spec => spec?.schema === SCHEMA;

/**
 * Validate a gauntlet/v1 spec. Returns an array of error strings (empty = valid).
 * A legacy pipeline (no `schema`) is returned as valid so migration stays additive -
 * subagents.mjs keeps owning its own validation.
 */
export function validateGauntlet(spec, agents = null, capabilities = null) {
  if (!isGauntletSpec(spec)) return [];
  const errors = [];
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : null;
  if (!nodes || !nodes.length) return ['spec has no nodes'];

  const names = new Set();
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== 'object') { errors.push(`node[${index}] must be an object`); continue; }
    if (!node.name) { errors.push(`node[${index}] has no name`); continue; }
    if (names.has(node.name)) errors.push(`duplicate node name: ${node.name}`);
    names.add(node.name);

    const kind = node.kind || 'work';
    if (!NODE_KINDS.includes(kind)) errors.push(`node ${node.name}: unknown kind '${kind}'`);
    if (!node.agent) errors.push(`node ${node.name}: missing agent`);
    else if (agents && !agents[node.agent]) errors.push(`node ${node.name}: unknown agent '${node.agent}'`);
    if (node.timeout != null && !(Number(node.timeout) > 0)) errors.push(`node ${node.name}: timeout must be a positive number`);

    if (node.compensate != null) {
      if (typeof node.compensate !== 'string') errors.push(`node ${node.name}: compensate must be a capability name`);
      // Rollback must itself be policy-gated; the engine may not invent one.
      else if (capabilities && !capabilities.includes(node.compensate)) {
        errors.push(`node ${node.name}: compensate '${node.compensate}' is not a harness capability`);
      }
    }

    if (kind === 'gate') {
      const on = node.on;
      if (!on || typeof on !== 'object' || !Object.keys(on).length) {
        errors.push(`gate ${node.name}: needs an 'on' map from verdict to target node`);
      } else {
        for (const [verdict, target] of Object.entries(on)) {
          if (!VERDICTS.includes(verdict)) errors.push(`gate ${node.name}: 'on' key '${verdict}' is not a verdict`);
          if (typeof target !== 'string' || !target) errors.push(`gate ${node.name}: 'on.${verdict}' must name a node`);
        }
        // Without a REROUTE edge the anti-thrash rule could only abort.
        if (RETRY in on && !(REROUTE in on)) {
          errors.push(`gate ${node.name}: declares a RETRY edge but no REROUTE edge, so the anti-thrash rule would have to abort instead of changing approach`);
        }
      }
    }
  }

  for (const node of nodes) {
    if (!node?.name) continue;
    for (const dep of node.depends_on || []) {
      if (!names.has(dep)) errors.push(`node ${node.name}: depends_on unknown node '${dep}'`);
    }
    for (const [verdict, target] of Object.entries(node.on || {})) {
      if (typeof target === 'string' && target && !names.has(target)) {
        errors.push(`gate ${node.name}: 'on.${verdict}' targets unknown node '${target}'`);
      }
    }
  }

  errors.push(...cycleErrors(nodes, names));

  const budget = spec.budget;
  if (budget != null) {
    if (typeof budget !== 'object') errors.push('budget must be an object');
    else for (const key of ['maxNodeRuns', 'maxUsdEstimate']) {
      const value = budget[key];
      if (value != null && !(Number(value) > 0)) errors.push(`budget.${key} must be a positive number`);
    }
  }
  return errors;
}

/** Reject cycles in depends_on. Gate `on` edges are deliberate bounded back-edges. */
function cycleErrors(nodes, names) {
  const graph = new Map();
  for (const node of nodes) {
    if (node?.name) graph.set(node.name, (node.depends_on || []).filter(d => names.has(d)));
  }
  const state = new Map();
  const trail = [];
  const visit = current => {
    if (state.get(current) === 'done') return false;
    if (state.get(current) === 'active') { trail.push(current); return true; }
    state.set(current, 'active');
    for (const dep of graph.get(current) || []) {
      if (visit(dep)) { trail.push(current); return true; }
    }
    state.set(current, 'done');
    return false;
  };
  for (const name of graph.keys()) {
    if (visit(name)) return [`dependency cycle detected: ${trail.reverse().join(' -> ')}`];
  }
  return [];
}

/** Node names in dependency order. Throws on a cycle. */
export function executionOrder(nodes) {
  const names = nodes.map(n => n.name);
  const deps = new Map(nodes.map(n => [n.name, (n.depends_on || []).filter(d => names.includes(d))]));
  const order = [];
  const state = new Map();
  const visit = name => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'active') throw new Error(`dependency cycle at '${name}'`);
    state.set(name, 'active');
    for (const dep of deps.get(name) || []) visit(dep);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of names) visit(name);
  return order;
}

/** Extract the first balanced {...}, ignoring braces inside strings. */
function firstJsonObject(text) {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

/**
 * Parse a gate's raw output into a verdict.
 * An unreadable gate becomes ABORT, never PASS: a broken gate is not a passed gate,
 * and failing closed is the only safe default.
 */
export function parseVerdict(text) {
  const blob = firstJsonObject(String(text ?? ''));
  if (!blob) return { verdict: ABORT, reasons: [{ code: 'GATE_UNPARSEABLE' }], remedy: null, confidence: null };
  let payload;
  try { payload = JSON.parse(blob); }
  catch { return { verdict: ABORT, reasons: [{ code: 'GATE_INVALID' }], remedy: null, confidence: null }; }

  const verdict = String(payload.verdict ?? '').trim().toUpperCase();
  if (!VERDICTS.includes(verdict)) {
    return { verdict: ABORT, reasons: [{ code: 'GATE_INVALID' }], remedy: null, confidence: null };
  }
  const reasons = (payload.reasons || []).map(r =>
    typeof r === 'string' ? { code: r } : { code: String(r?.code ?? '').trim(), detail: r?.detail ?? '' })
    .filter(r => r.code);
  if (verdict !== PASS && !reasons.length) {
    return { verdict: ABORT, reasons: [{ code: 'GATE_INVALID' }], remedy: null, confidence: null };
  }
  return { verdict, reasons, remedy: payload.remedy || null, confidence: payload.confidence ?? null };
}

/** Records non-passing verdicts so a known-failed approach cannot recur forever. */
export class AttemptLedger {
  constructor() { this.entries = []; this.reroutes = new Map(); this.escalations = new Map(); }
  #key(node, code) { return `${node}\u001f${code}`; }
  record(node, verdict) {
    if (verdict.verdict === PASS) return;
    for (const reason of verdict.reasons.length ? verdict.reasons : [{ code: 'UNSPECIFIED' }]) {
      this.entries.push({ node, verdict: verdict.verdict, code: reason.code, detail: reason.detail || '' });
    }
  }
  count(node, code) { return code == null ? 0 : this.entries.filter(e => e.node === node && e.code === code).length; }
  forbidsRetry(node, code) { return this.count(node, code) >= MAX_SAME_REASON_RETRIES; }
  rejections(node) { return this.entries.filter(e => e.node === node).length; }
  exhausted(node) { return this.rejections(node) >= MAX_GATE_REJECTIONS; }
  recordReroute(node, code) { if (code != null) this.reroutes.set(this.#key(node, code), (this.reroutes.get(this.#key(node, code)) || 0) + 1); }
  rerouteCount(node, code) { return code == null ? 0 : (this.reroutes.get(this.#key(node, code)) || 0); }
  forbidsReroute(node, code) { return this.rerouteCount(node, code) >= MAX_SAME_REASON_REROUTES; }
  recordEscalation(node, code) { if (code != null) this.escalations.set(this.#key(node, code), (this.escalations.get(this.#key(node, code)) || 0) + 1); }
  escalationCount(node, code) { return code == null ? 0 : (this.escalations.get(this.#key(node, code)) || 0); }
  forbidsEscalation(node, code) { return this.escalationCount(node, code) >= MAX_SAME_REASON_ESCALATIONS; }
  asPromptBlock(node) {
    const mine = this.entries.filter(e => e.node === node);
    if (!mine.length) return '';
    return ['ALREADY TRIED AND FAILED - do not repeat these approaches:',
      ...mine.map(e => `  * [${e.code}]${e.detail ? ` - ${e.detail}` : ''}`),
      'Choose a materially different approach.'].join('\n');
  }
}

/** Detects semantic no-progress: two identical artifacts is by definition no progress. */
export class ProgressTracker {
  constructor() { this.seen = new Map(); }
  static fingerprint(artifact) { return String(artifact ?? '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  observe(node, artifact) {
    const digest = ProgressTracker.fingerprint(artifact);
    const bucket = this.seen.get(node) || new Set();
    const repeat = bucket.has(digest);
    bucket.add(digest);
    this.seen.set(node, bucket);
    return repeat;
  }
}

const routing = (action, target, verdict, reason, forced = false) => ({ action, target, verdict, reason, forced });

function climb(on, name, code, reason, ledger) {
  // Escalation is bounded too: the top tier is the worst place to loop because it
  // is the most expensive.
  if (ledger && ledger.forbidsEscalation(name, code)) {
    return routing(STOP, null, ABORT, `${reason}; the stronger tier also failed - stopping with a partial result`, true);
  }
  const target = on[ESCALATE];
  if (target) return routing(TIER_UP, target, ESCALATE, reason, true);
  return routing(STOP, null, ABORT, `${reason}; no ESCALATE edge exists`, true);
}

function rerouteOrClimb(on, ledger, name, code, reason) {
  if (ledger.forbidsReroute(name, code)) {
    return climb(on, name, code, `${reason}, and ${MAX_SAME_REASON_REROUTES} reroutes also failed`, ledger);
  }
  const target = on[REROUTE];
  if (!target) return routing(STOP, null, ABORT, `${reason}, and no REROUTE edge exists`, true);
  return routing(ALTERNATIVE, target, REROUTE, reason, true);
}

/**
 * Turn a verdict into the single legal action for `node`.
 * Two structural guarantees hold regardless of what the gate asked for:
 *   1. a third RETRY on the same reason code becomes REROUTE
 *   2. a node that repeated an artifact is rerouted, never retried
 */
export function route(verdict, node, ledger = new AttemptLedger(), { noProgress = false } = {}) {
  const name = String(node?.name ?? '<unnamed>');
  const on = node?.on || {};
  const code = verdict.reasons?.[0]?.code ?? null;

  if (verdict.verdict === PASS) return routing(ADVANCE, on[PASS], PASS, 'acceptance criteria met');
  if (verdict.verdict === ABORT) return routing(STOP, on[ABORT], ABORT, code || 'aborted');

  if (verdict.verdict === ESCALATE) {
    if (ledger.forbidsEscalation(name, code)) {
      return routing(STOP, null, ABORT,
        `'${code}' already escalated ${MAX_SAME_REASON_ESCALATIONS}x and still fails; stopping rather than spending more on a known-failing approach`, true);
    }
    const target = on[ESCALATE];
    if (!target) return routing(STOP, null, ABORT, `escalation required but no ${ESCALATE} edge exists`);
    return routing(TIER_UP, target, ESCALATE, code || 'escalated');
  }

  if (verdict.verdict === RETRY) {
    if (noProgress) return rerouteOrClimb(on, ledger, name, code, `no progress: ${name} repeated a previous artifact`);
    if (ledger.exhausted(name)) {
      // Code-independent: this gate has rejected too often to be progressing,
      // whatever it is calling the failures.
      return rerouteOrClimb(on, ledger, name, code,
        `${name} rejected ${ledger.rejections(name)}x (${MAX_GATE_REJECTIONS} allowed) regardless of reason code`);
    }
    if (ledger.forbidsRetry(name, code)) {
      return rerouteOrClimb(on, ledger, name, code, `anti-thrash: '${code}' already failed ${MAX_SAME_REASON_RETRIES}x`);
    }
    const target = verdict.remedy || on[RETRY];
    if (!target) return routing(STOP, null, ABORT, 'retry requested but no remedy or RETRY edge exists');
    return routing(REMEDY, target, RETRY, code || 'retry');
  }

  // REROUTE requested outright by the gate.
  if (ledger.forbidsReroute(name, code)) {
    return climb(on, name, code, `'${code}' survived ${MAX_SAME_REASON_REROUTES} reroutes`, ledger);
  }
  const target = on[REROUTE];
  if (!target) return routing(STOP, null, ABORT, 'reroute requested but no REROUTE edge exists');
  return routing(ALTERNATIVE, target, REROUTE, code || 'reroute');
}
