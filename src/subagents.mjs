// Subagent pipelines: a validated DAG runner with parallel waves, fan-in, bounded loops,
// per-stage timeouts, and a per-run budget. Every guarantee here exists so a pipeline
// degrades to a partial result instead of hanging or overspending.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { estimateCostUsd } from './models.mjs';

export const MAX_DEPTH = 3;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_STAGE_TIMEOUT_S = 300;

// ------------------------------------------------------------------ definitions

export async function loadAgents(root = process.cwd()) {
  const dir = path.join(root, '.ultron', 'agents');
  let names;
  try { names = await fs.readdir(dir); } catch { return {}; }
  const agents = {};
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`Invalid agent ${name}: ${error.message}`); }
    const key = parsed.name || path.basename(name, '.json');
    if (!parsed.provider) throw new Error(`Agent ${key} is missing "provider"`);
    agents[key] = { name: key, tools: [], permissionProfile: 'read-only', ...parsed };
  }
  return agents;
}

export async function loadPipeline(root, name) {
  const file = path.isAbsolute(name) || name.endsWith('.json') ? name : path.join(root, '.ultron', 'pipelines', `${name}.json`);
  const raw = await fs.readFile(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`Invalid pipeline ${file}: ${error.message}`); }
  return { ...parsed, name: parsed.name || path.basename(file, '.json'), file };
}

// -------------------------------------------------------------------- validation

export function validatePipeline(pipeline, agents = null) {
  const errors = [];
  const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : [];
  if (!stages.length) errors.push('pipeline has no stages');

  const seen = new Set();
  for (const [index, stage] of stages.entries()) {
    if (!stage?.name) { errors.push(`stage[${index}] has no name`); continue; }
    if (seen.has(stage.name)) errors.push(`duplicate stage name: ${stage.name}`);
    seen.add(stage.name);
    if (!stage.agent) errors.push(`stage ${stage.name}: missing "agent"`);
    else if (agents && !agents[stage.agent]) errors.push(`stage ${stage.name}: unknown agent "${stage.agent}"`);
    if (stage.timeout != null && !(Number(stage.timeout) > 0)) errors.push(`stage ${stage.name}: timeout must be > 0`);
  }
  for (const stage of stages) {
    for (const dep of stage?.depends_on || []) {
      if (!seen.has(dep)) errors.push(`stage ${stage.name}: depends_on unknown stage "${dep}"`);
    }
    const loop = stage?.loop_to;
    if (loop) {
      if (!loop.target) errors.push(`stage ${stage.name}: loop_to needs a target`);
      else if (!seen.has(loop.target)) errors.push(`stage ${stage.name}: loop_to target "${loop.target}" does not exist`);
      if (!loop.trigger) errors.push(`stage ${stage.name}: loop_to needs a trigger string`);
      const max = Number(loop.max_iterations);
      if (!Number.isInteger(max) || max < 1 || max > 10) errors.push(`stage ${stage.name}: loop_to.max_iterations must be an integer 1-10`);
    }
  }

  // Cycle detection over depends_on only (loop_to is an explicit, bounded back-edge).
  const graph = new Map(stages.filter(s => s?.name).map(s => [s.name, (s.depends_on || []).slice()]));
  const state = new Map();
  const cycle = [];
  const visit = node => {
    if (state.get(node) === 'done') return false;
    if (state.get(node) === 'active') { cycle.push(node); return true; }
    state.set(node, 'active');
    for (const dep of graph.get(node) || []) {
      if (graph.has(dep) && visit(dep)) { cycle.push(node); return true; }
    }
    state.set(node, 'done');
    return false;
  };
  for (const node of graph.keys()) {
    if (visit(node)) { errors.push(`dependency cycle detected: ${[...cycle].reverse().join(' -> ')}`); break; }
  }

  return { valid: errors.length === 0, errors };
}

/** Group stages into parallel waves by topological level. Throws if the DAG is invalid. */
export function computeWaves(pipeline) {
  const check = validatePipeline(pipeline);
  if (!check.valid) throw new Error(`Invalid pipeline: ${check.errors.join('; ')}`);
  const stages = pipeline.stages;
  const remaining = new Map(stages.map(s => [s.name, new Set(s.depends_on || [])]));
  const waves = [];
  const settled = new Set();
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every(d => settled.has(d))).map(([name]) => name);
    if (!ready.length) throw new Error('Invalid pipeline: unreachable stages (cycle or missing dependency)');
    waves.push(ready);
    for (const name of ready) { remaining.delete(name); settled.add(name); }
  }
  return waves;
}

export function toMermaid(pipeline) {
  const lines = ['graph TD'];
  for (const stage of pipeline.stages || []) {
    lines.push(`  ${stage.name}["${stage.name}<br/>${stage.agent || '?'}"]`);
    for (const dep of stage.depends_on || []) lines.push(`  ${dep} --> ${stage.name}`);
    if (stage.loop_to) lines.push(`  ${stage.name} -. "${stage.loop_to.trigger} (max ${stage.loop_to.max_iterations})" .-> ${stage.loop_to.target}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------- helpers

export function renderPrompt(template, context) {
  return String(template ?? '').replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(context, key) ? String(context[key] ?? '') : whole);
}

const backoffDelay = (attempt, backoff) => {
  if (!backoff) return 0;
  const base = Number(backoff.baseMs || 500);
  const capped = Math.min(Number(backoff.maxMs || 10000), base * 2 ** Math.max(0, attempt - 1));
  return backoff.jitter === false ? capped : Math.round(capped * (0.75 + Math.random() * 0.5));
};

const withTimeout = (promise, seconds, label) => {
  if (!seconds) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Stage "${label}" timed out after ${seconds}s`)), seconds * 1000); })
  ]);
};

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// --------------------------------------------------------------------- executor

/**
 * Execute a pipeline.
 * `invoke({ agent, prompt, stage, signal })` must resolve to { text, usage?, model? }.
 * Always resolves — never throws — so a caller gets a partial result with a reason.
 */
export async function runPipeline({
  pipeline, agents = {}, task = '', invoke,
  concurrency = DEFAULT_CONCURRENCY, depth = 0, onEvent = () => {},
  budget: budgetOverride = null
} = {}) {
  if (typeof invoke !== 'function') throw new Error('runPipeline requires an invoke() function');
  if (depth >= MAX_DEPTH) {
    return { ok: false, partial: true, reason: `subagent depth cap of ${MAX_DEPTH} reached`, stages: {}, stageRuns: 0, estimatedCostUsd: 0 };
  }

  const check = validatePipeline(pipeline, Object.keys(agents).length ? agents : null);
  if (!check.valid) return { ok: false, partial: false, reason: `invalid pipeline: ${check.errors.join('; ')}`, stages: {}, stageRuns: 0, estimatedCostUsd: 0 };

  const waves = computeWaves(pipeline);
  const budget = { maxStageRuns: 24, maxUsdEstimate: null, ...(pipeline.budget || {}), ...(budgetOverride || {}) };
  const byName = new Map(pipeline.stages.map(s => [s.name, s]));
  const stages = {};
  const loopCounts = new Map();
  let stageRuns = 0, estimatedCostUsd = 0, aborted = null;

  const budgetExceeded = () => {
    if (stageRuns >= Number(budget.maxStageRuns)) return `stage-run budget of ${budget.maxStageRuns} exhausted`;
    if (budget.maxUsdEstimate != null && estimatedCostUsd >= Number(budget.maxUsdEstimate)) return `cost budget of $${budget.maxUsdEstimate} reached (est. $${estimatedCostUsd.toFixed(4)})`;
    return null;
  };

  const executeStage = async (stage, context) => {
    // Budget is checked BEFORE the call so we never overspend, only under-spend.
    const exceeded = budgetExceeded();
    if (exceeded) { aborted = exceeded; return { name: stage.name, ok: false, skipped: true, reason: exceeded }; }

    const agent = agents[stage.agent] || { name: stage.agent };
    const prompt = renderPrompt(stage.prompt ?? '{task}', context);
    const seconds = Number(stage.timeout || DEFAULT_STAGE_TIMEOUT_S);
    stageRuns++;
    onEvent({ type: 'stage-start', stage: stage.name, agent: agent.name, run: stageRuns });
    try {
      const response = await withTimeout(Promise.resolve(invoke({ agent, prompt, stage, task })), seconds, stage.name);
      const text = typeof response === 'string' ? response : (response?.text ?? '');
      const modelId = (typeof response === 'object' && response?.model) || agent.model;
      if (modelId && response?.usage) {
        try { estimatedCostUsd += estimateCostUsd(modelId, response.usage); } catch { /* unknown model: no estimate */ }
      }
      onEvent({ type: 'stage-ok', stage: stage.name });
      return { name: stage.name, ok: true, text, model: modelId || null, usage: response?.usage || null };
    } catch (error) {
      onEvent({ type: 'stage-fail', stage: stage.name, reason: error.message });
      return { name: stage.name, ok: false, reason: error.message };
    }
  };

  const contextFor = () => {
    const ctx = { task };
    for (const [name, result] of Object.entries(stages)) ctx[name] = result.text || '';
    return ctx;
  };

  for (const wave of waves) {
    if (aborted) break;
    // A stage whose dependency failed or was skipped cannot run; independent branches continue.
    const runnable = wave.filter(name => {
      const stage = byName.get(name);
      const blocked = (stage.depends_on || []).filter(d => !stages[d]?.ok);
      if (blocked.length) { stages[name] = { name, ok: false, skipped: true, reason: `blocked by ${blocked.join(', ')}` }; return false; }
      return true;
    });

    const outcomes = await runWithConcurrency(runnable, concurrency, name => executeStage(byName.get(name), contextFor()));
    for (const outcome of outcomes) stages[outcome.name] = outcome;

    // Bounded loop-backs, evaluated after the wave so fan-in is intact.
    for (const name of runnable) {
      if (aborted) break;
      const stage = byName.get(name);
      const loop = stage.loop_to;
      const result = stages[name];
      if (!loop || !result?.ok || !String(result.text || '').includes(loop.trigger)) continue;

      const key = `${name}->${loop.target}`;
      let iteration = loopCounts.get(key) || 0;
      while (iteration < Number(loop.max_iterations)) {
        iteration++; loopCounts.set(key, iteration);
        const delay = backoffDelay(iteration, loop.backoff);
        // Not unref'd: this IS the wait. An unref'd timer cannot keep the loop alive, so if
        // nothing else does the process exits and the await never resolves - which on Linux
        // showed up as nine cancelled pipeline tests. Same class of bug as the stage timeout
        // above and the hook timeout in hooks.mjs: unref belongs on cosmetic timers (spinners,
        // progress repaints, kill-escalation cleanup), never on one whose firing is the point.
        if (delay) await new Promise(r => { setTimeout(r, delay); });
        onEvent({ type: 'loop', from: name, to: loop.target, iteration });

        const target = byName.get(loop.target);
        stages[loop.target] = await executeStage(target, { ...contextFor(), feedback: stages[name].text || '' });
        if (aborted) break;
        stages[name] = await executeStage(stage, contextFor());
        if (aborted) break;
        if (!stages[name]?.ok || !String(stages[name].text || '').includes(loop.trigger)) break;
      }
      if (!aborted && stages[name]?.ok && String(stages[name].text || '').includes(loop.trigger)) {
        stages[name].loopExhausted = true;
        stages[name].reason = `loop to ${loop.target} exhausted after ${iteration} iteration(s); trigger "${loop.trigger}" still present`;
      }
    }
  }

  const values = Object.values(stages);
  const failed = values.filter(s => !s.ok);
  const exhausted = values.filter(s => s.loopExhausted);
  const ok = !aborted && failed.length === 0 && exhausted.length === 0;
  return {
    ok,
    partial: !ok,
    reason: aborted || (failed.length ? `${failed.length} stage(s) did not succeed: ${failed.map(s => s.name).join(', ')}` : (exhausted.length ? exhausted[0].reason : null)),
    stages, waves, stageRuns,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    budget
  };
}
