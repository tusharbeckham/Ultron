// Guards — the controls that sit underneath Ultron's permission profiles.
//
// Permission profiles answer "may this session write files / run shell / reach the
// web?". They do not answer what remains once the answer is yes:
//
//   boundedCapture  — can a child process exhaust our memory with output?
//   safeResolve     — is this path really where it claims to be? (Windows especially)
//   appendAudit     — can someone rewrite the record of what Ultron did?
//   redact          — is a secret about to be written into that record?
//   TokenBucket     — can a looping agent call something ten thousand times?
//
// These are deliberately the same controls, with the same names and the same wire
// format, as `scripts/harness_guards.py` in Alfred. Ultron and Alfred share the
// `gauntlet/v1` spec, and the project's rule is that a guarantee belongs to the SPEC
// rather than to whichever runtime happens to execute it. A bound that Alfred enforces
// and Ultron does not is a bound you can escape by changing which binary you type.
//
// The audit chain in particular is byte-compatible on purpose: a chain written by
// Ultron verifies under Alfred's `chain_verify`, and vice versa. There is a parity
// test asserting exactly that.
//
// Zero dependencies, as everywhere else in this CLI.

import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class GuardError extends Error {
  constructor(message) { super(message); this.name = 'GuardError'; }
}

const WINDOWS = process.platform === 'win32';

// --------------------------------------------------------------------- path confinement

// Reserved DOS device names. These are magic in EVERY directory on Windows: opening
// "C:\project\CON" does not touch the filesystem, it opens the console device. A write
// silently vanishes; a read can block forever. No legitimate path names one.
const DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
]);

const SHORT_NAME_RE = /~\d/;

function isDeviceComponent(component) {
  // Windows strips trailing dots and spaces before resolving, and ignores everything
  // from the first dot for device purposes, so "NUL " and "NUL.txt" both reach the device.
  const stripped = component.replace(/[ .]+$/, '');
  return DEVICE_NAMES.has(stripped.split('.')[0].toUpperCase());
}

/**
 * Resolve a caller-supplied path into something safe to hand to a tool.
 *
 * Refuses UNC/extended-length paths (they bypass the very normalization confinement
 * depends on), NTFS alternate data streams (the visible path passes while the write
 * lands in a hidden stream — the CVE-2025-8088 shape), DOS device names, components
 * with trailing dots or spaces (Windows strips them, so the path checked is not the
 * path used), and unresolved 8.3 short names.
 *
 * Then normalizes with NFC and follows symlinks/junctions via realpath, so a link
 * inside the workspace pointing outside it resolves to its real target and is caught
 * by insideRoots rather than tunnelling through it.
 */
export function safeResolve(raw, base = process.cwd()) {
  if (typeof raw !== 'string' || !raw.trim()) throw new GuardError('empty path');

  // NFC first: two byte sequences that display identically must not be able to produce
  // two different confinement answers.
  const value = raw.normalize('NFC');
  if (value.includes('\0')) throw new GuardError('path contains a NUL byte');

  const slashed = value.replace(/\\/g, '/');
  if (slashed.startsWith('//')) {
    throw new GuardError('UNC and extended-length paths are refused (they bypass path normalization)');
  }

  // Alternate data streams: a colon anywhere except the drive separator at index 1.
  const hasDrive = value.length > 1 && value[1] === ':';
  const remainder = hasDrive ? value.slice(2) : value;
  if (remainder.includes(':')) {
    throw new GuardError("alternate data streams (':' in a path component) are refused");
  }

  const absolute = path.isAbsolute(value) ? value : path.resolve(base, value);
  for (const component of absolute.replace(/\\/g, '/').split('/')) {
    if (!component || component.endsWith(':')) continue;
    if (isDeviceComponent(component)) {
      throw new GuardError(`path component '${component}' names a Windows device`);
    }
    // "." and ".." legitimately consist of dots. realpath collapses them and the real
    // target is what gets confined, so refusing them would break ordinary relative
    // paths for no security gain.
    if (component !== '.' && component !== '..' && /[ .]$/.test(component)) {
      throw new GuardError(`path component '${component}' has trailing dots/spaces (Windows strips these, so the checked path is not the used path)`);
    }
  }

  // 8.3 short names are checked AFTER resolution, not before. `realpath` expands them, and a
  // short component is only a problem if it SURVIVES that. Refusing them up front rejected a
  // legitimate path whose ancestor happens to be shortened - `C:\Users\RUNNER~1\...` on a CI
  // runner, or any username long enough for Windows to abbreviate. Alfred hit exactly that and
  // its CI caught it; this keeps the two engines agreeing, which a parity test enforces.
  const resolved = resolvePreservingTail(absolute);
  if (SHORT_NAME_RE.test(resolved)) {
    throw new GuardError('path contains an unresolvable 8.3 short name (~N); supply the long path');
  }
  return resolved;
}

/** realpath, falling back to the deepest existing ancestor when the target does not exist.
 *
 *  Uses `realpathSync.native` rather than `realpathSync`: the JS implementation does NOT expand
 *  8.3 short names on Windows (`C:\PROGRA~1` comes back unchanged), whereas the native one goes
 *  through the Win32 API and returns `C:\Program Files`. Without that, Ultron would refuse
 *  legitimate paths under a shortened ancestor while Alfred accepted them, and a parity test
 *  would - and did - catch the divergence. */
function resolvePreservingTail(absolute) {
  const real = p => {
    try { return realpathSync.native(p); } catch { return realpathSync(p); }
  };
  try {
    return real(absolute);
  } catch {
    // The path does not exist yet — legitimate for a file about to be written. Resolve the
    // deepest existing ancestor instead, so a junction anywhere ABOVE the target is still
    // followed and still confined, and a shortened ancestor is still expanded.
    let current = absolute;
    const trailing = [];
    for (let i = 0; i < 64; i += 1) {
      const parent = path.dirname(current);
      if (parent === current) break;
      trailing.unshift(path.basename(current));
      current = parent;
      if (existsSync(current)) {
        try { return path.join(real(current), ...trailing); } catch { break; }
      }
    }
    return path.normalize(absolute);
  }
}

/** True if `target` sits inside one of `roots`, comparing real paths on both sides. */
export function insideRoots(target, roots) {
  const resolve = p => { try { return realpathSync(p); } catch { return path.normalize(p); } };
  const child = resolve(String(target));
  const compare = WINDOWS ? s => s.toLowerCase() : s => s;
  for (const root of roots || []) {
    const parent = compare(resolve(String(root)));
    const candidate = compare(child);
    if (candidate === parent) return true;
    if (candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)) return true;
  }
  return false;
}

// -------------------------------------------------------------------------- output caps

/**
 * A sink that accumulates at most `limit` bytes and then stops, remembering that it
 * did. Attach it to a child's stdout/stderr instead of `out += chunk`.
 *
 * `out += chunk` on a child that writes 4 GB takes the whole CLI down with it. That is
 * a denial of service reachable through any hook or tool a session is allowed to run,
 * and the size of a command's output usually depends on the state of the machine rather
 * than on anything the permission profile can see.
 */
export function boundedCapture(limit = 1024 * 1024) {
  let text = '', bytes = 0, truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const piece = typeof chunk === 'string' ? chunk : String(chunk);
      const size = Buffer.byteLength(piece, 'utf8');
      if (bytes + size <= limit) { text += piece; bytes += size; return; }
      // Keep the prefix that fits: the useful signal in a command's output is almost
      // always near the start, and a partial answer beats an empty one.
      const room = limit - bytes;
      if (room > 0) text += Buffer.from(piece, 'utf8').subarray(0, room).toString('utf8');
      bytes = limit;
      truncated = true;
    },
    get value() { return truncated ? `${text}\n[ultron] output truncated at ${limit} bytes\n` : text; },
    get truncated() { return truncated; },
    get bytes() { return bytes; }
  };
}

// ------------------------------------------------------------------- audit hash chain

export const CHAIN_GENESIS = '0'.repeat(64);

/**
 * Canonical JSON: sorted keys, no incidental whitespace.
 *
 * This has to match Python's `json.dumps(obj, sort_keys=True, separators=(",", ":"))`
 * byte for byte, because the whole point is that Alfred can verify a chain Ultron wrote.
 * Compact separators are the canonical choice precisely because they are the one form
 * both languages produce identically without configuration gymnastics.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function chainHash(prev, payload) {
  return createHash('sha256').update(`${prev}\n${payload}`, 'utf8').digest('hex');
}

function lastChainState(file) {
  if (!existsSync(file)) return { seq: 0, hash: CHAIN_GENESIS };
  let size = 0;
  try { size = statSync(file).size; } catch { return { seq: 0, hash: CHAIN_GENESIS }; }
  if (size === 0) return { seq: 0, hash: CHAIN_GENESIS };
  // Read only the tail. The trail grows without bound by design, and re-reading all of
  // it on every append would make Ultron slower the longer it had been used.
  const window = Math.min(size, 65536);
  const buffer = Buffer.alloc(window);
  const fd = readFileSync(file);
  fd.copy(buffer, 0, size - window, size);
  const lines = buffer.toString('utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i]);
      if (record.chain && record.seq) return { seq: Number(record.seq), hash: String(record.chain) };
      return { seq: 0, hash: CHAIN_GENESIS };
    } catch { /* partial line at the window edge; keep looking */ }
  }
  return { seq: 0, hash: CHAIN_GENESIS };
}

/**
 * Append one tamper-evident record and return what was stored.
 *
 * Stops: silent edits and deletions inside the trail — change any record and every
 * later link mismatches, so `verifyAudit` names the exact line where history was
 * rewritten. Does NOT stop: whoever can write the file cutting off the tail and
 * continuing a fresh valid chain. That needs an external witness, which is what
 * `checkpointAudit` writes — the limitation is documented rather than papered over.
 */
export function appendAudit(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const { seq, hash: prev } = lastChainState(file);
  const body = { seq: seq + 1, prev, ...record };
  const payload = canonicalJson(body);
  body.chain = chainHash(prev, payload);
  appendFileSync(file, `${JSON.stringify(body)}\n`, 'utf8');
  return body;
}

export function verifyAudit(file) {
  if (!existsSync(file)) return { ok: true, records: 0, chained: 0, legacy: 0, note: 'no audit log yet' };
  let prev = CHAIN_GENESIS, total = 0, chained = 0, legacy = 0, expectedSeq = 0;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    total += 1;
    let record;
    try { record = JSON.parse(line); }
    catch { return { ok: false, records: total, chained, legacy, brokenAt: i + 1, reason: 'line is not valid JSON' }; }
    if (!record.chain) { legacy += 1; continue; }
    const stored = String(record.chain);
    delete record.chain;
    if (Number(record.seq) !== expectedSeq + 1) {
      return { ok: false, records: total, chained, legacy, brokenAt: i + 1, reason: `sequence jumped: expected ${expectedSeq + 1}, got ${record.seq}` };
    }
    if (chainHash(prev, canonicalJson(record)) !== stored) {
      return { ok: false, records: total, chained, legacy, brokenAt: i + 1, reason: 'hash mismatch — this record was altered' };
    }
    prev = stored;
    expectedSeq = Number(record.seq);
    chained += 1;
  }
  return { ok: true, records: total, chained, legacy, head: prev };
}

export function checkpointAudit(file, witnessFile) {
  const state = verifyAudit(file);
  if (!state.ok) throw new GuardError(`refusing to checkpoint a broken chain: ${state.reason}`);
  const payload = { ts: new Date().toISOString(), records: state.records, chained: state.chained, head: state.head || CHAIN_GENESIS };
  mkdirSync(path.dirname(witnessFile), { recursive: true });
  appendFileSync(witnessFile, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

export function auditPath() {
  const home = process.env.ULTRON_HOME || path.join(os.homedir(), '.ultron');
  return path.join(home, 'audit.jsonl');
}

// ------------------------------------------------------------------------------ redaction

// Allowlist, not denylist. A denylist of secret-shaped regexes has to anticipate every
// format a secret can take; an allowlist only has to know which fields are boring. When
// a new field appears tomorrow, its value is withheld by default instead of being
// written into an append-only file forever.
export const DEFAULT_LOGGABLE_FIELDS = Object.freeze([
  'pipeline', 'spec', 'task', 'stage', 'provider', 'model', 'verdict', 'reason', 'path', 'tool', 'event'
]);

const SECRET_SHAPED = [
  /(api[_-]?key|secret|password|passwd|token|bearer|authorization)/i,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{10,}/
];

export const REDACTED = '[REDACTED]';

/** Field NAMES are kept — knowing a token was supplied is useful and reveals nothing.
 *  Field VALUES are the risk. */
export function redact(fields, loggable = DEFAULT_LOGGABLE_FIELDS) {
  const allowed = new Set(loggable);
  const out = {};
  for (const [name, value] of Object.entries(fields || {})) {
    if (!allowed.has(name)) { out[name] = REDACTED; continue; }
    const text = String(value);
    if (SECRET_SHAPED.some(re => re.test(name)) || SECRET_SHAPED.some(re => re.test(text))) {
      out[name] = REDACTED; continue;
    }
    out[name] = text;
  }
  return out;
}

// --------------------------------------------------------------------------------- quota

/**
 * A persisted token bucket, one bucket per key.
 *
 * A bucket rather than a fixed window: a fixed window lets a caller spend its whole
 * allowance in the last second of one window and again in the first second of the next,
 * which is exactly the burst a runaway loop produces. A bucket smooths that while still
 * permitting a legitimate short burst.
 *
 * An unreadable state file is treated as full rather than empty: failing closed is right
 * for authorization and wrong for a quota file, because a torn write must not be able to
 * lock the user out of their own tool. The next successful write repairs it.
 */
export class TokenBucket {
  constructor(file, now = Date.now() / 1000) { this.file = file; this.now = now; }

  #load() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; } }

  #save(state) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    renameSync(tmp, this.file);
  }

  consume(key, perMinute, burst = null) {
    if (!perMinute || perMinute <= 0) return { limited: false, reason: 'no limit configured' };
    const capacity = Number(burst ?? perMinute);
    const state = this.#load();
    const bucket = state[key] || {};
    let tokens = Number(bucket.tokens ?? capacity);
    const elapsed = Math.max(0, this.now - Number(bucket.ts ?? this.now));
    tokens = Math.min(capacity, tokens + elapsed * (perMinute / 60));

    if (tokens < 1) {
      const wait = (1 - tokens) / (perMinute / 60);
      state[key] = { tokens, ts: this.now };
      this.#save(state);
      throw new GuardError(`rate limit exceeded for '${key}': ${perMinute}/min (burst ${capacity}); retry in ${wait.toFixed(1)}s`);
    }
    tokens -= 1;
    state[key] = { tokens, ts: this.now };
    this.#save(state);
    return { limited: true, remaining: Math.round(tokens * 100) / 100, capacity };
  }
}

// -------------------------------------------------------------------------- confinement

/**
 * Windows Job Objects and POSIX `setrlimit` are both kernel facilities Node cannot reach
 * without a native module, and this CLI has no dependencies. So confinement here is built the
 * only way it can be: by *wrapping argv* with programs that already do it.
 *
 *   prlimit --as=N --cpu=N --nproc=N --fsize=N --  <cmd>     (util-linux)
 *   unshare --user --map-current-user --net --     <cmd>     (util-linux)
 *
 * Still argv-only, still `shell: false` — the wrapper is an argv array and the real command
 * follows it after `--`, so nothing about the no-shell guarantee changes.
 *
 * Honest limits, stated because a confinement story that overclaims is worse than none:
 *
 * - **Windows gets nothing.** There is no argv wrapper equivalent. `confineArgv` reports that
 *   rather than returning an unchanged argv and letting the caller assume it worked.
 * - `--map-current-user` keeps the child's uid. `--map-root-user` would make it believe it is
 *   root — harmless on the host, but a script branching on `geteuid() === 0` would take a
 *   privileged path it should not.
 * - A fresh network namespace's loopback is DOWN, so isolation blocks `localhost` too. A tool
 *   that talks to LM Studio genuinely needs the network and must not be isolated.
 */
export const PRLIMIT = 'prlimit';
export const NETNS_PREFIX = Object.freeze(['unshare', '--user', '--map-current-user', '--net', '--']);

/** Build the wrapped argv. Returns `{ argv, applied, note }` — `applied` lists what actually
 *  got wrapped, so a caller can log what happened rather than what was requested. */
export function confineArgv(argv, limits = {}, { isolateNetwork = false, platform = process.platform } = {}) {
  const applied = [];
  if (platform === 'win32') {
    return { argv: [...argv], applied, note: 'windows: no argv-level confinement available' };
  }

  let out = [...argv];

  const flags = [];
  if (limits.memoryBytes) flags.push(`--as=${Math.floor(limits.memoryBytes)}`);
  if (limits.cpuSeconds) flags.push(`--cpu=${Math.floor(limits.cpuSeconds)}`);
  if (limits.activeProcesses) flags.push(`--nproc=${Math.floor(limits.activeProcesses)}`);
  if (limits.maxFileBytes) flags.push(`--fsize=${Math.floor(limits.maxFileBytes)}`);
  if (flags.length) {
    out = [PRLIMIT, ...flags, '--', ...out];
    applied.push('rlimits');
  }

  // Egress wrapper goes OUTERMOST so the namespace is entered before the limits are applied.
  // The order matters for readability more than behaviour, but it also means prlimit's own
  // process is inside the namespace rather than outside it.
  if (isolateNetwork) {
    out = [...NETNS_PREFIX, ...out];
    applied.push('netns');
  }

  return {
    argv: out,
    applied,
    note: applied.length ? `confined: ${applied.join('+')}` : 'no limits configured',
  };
}

/** Resource ceilings, scaled by permission profile. Mirrors Alfred's confinementByTrust. */
export const PROFILE_LIMITS = Object.freeze({
  'read-only': { memoryBytes: 512 * 1024 * 1024, cpuSeconds: 120, activeProcesses: 16, maxFileBytes: 64 * 1024 * 1024 },
  balanced: { memoryBytes: 2048 * 1024 * 1024, cpuSeconds: 900, activeProcesses: 64, maxFileBytes: 512 * 1024 * 1024 },
  // `unrestricted` means unrestricted here too, for the same reason it has no path boundary:
  // an escape hatch that does not exist gets replaced by using a broader profile everywhere.
  unrestricted: {},
});

export function limitsForProfile(name) {
  return PROFILE_LIMITS[name] ?? PROFILE_LIMITS['read-only'];
}

// -------------------------------------------------------------------------- scoped tokens

export const TOKEN_VERSION = 'aht2';

/**
 * Mint a scope-bound, expiring token. Same construction and same wire format as
 * Alfred's `harness mint-token`, so the two systems can hand credentials to each other.
 *
 * The scopes and the expiry live INSIDE the MAC. That is the answer to the confused
 * deputy: a token issued so an agent can read cannot be turned against a write by
 * anything that merely edits the token, because editing it is forgery.
 *
 * `iat` (issued-at) exists for revocation. Without it the only way to revoke is to name
 * each leaked token individually, which is useless in the case that actually matters —
 * "a credential leaked and I do not know which one". With it, revoking a whole subject
 * is one timestamp.
 */
export function mintToken(key, subject, scopes, ttlSeconds, now = Math.floor(Date.now() / 1000)) {
  const exp = now + Number(ttlSeconds);
  const nonce = randomBytes(9).toString('base64url');
  const scopeText = [...scopes].sort().join('+') || '*';
  const body = `${TOKEN_VERSION}.${subject}.${now}.${exp}.${nonce}.${scopeText}`;
  const mac = createHmac('sha256', key).update(body, 'utf8').digest('hex').slice(0, 32);
  return `${body}.${mac}`;
}

export function verifyToken(key, token, subject, scope, now = Math.floor(Date.now() / 1000), revocations = null) {
  const parts = String(token).split('.');
  if (parts.length !== 7 || parts[0] !== TOKEN_VERSION) throw new GuardError('not a scoped token');
  const [, tokSubject, iatText, expText, nonce, scopeText, mac] = parts;
  const body = parts.slice(0, 6).join('.');
  const expected = createHmac('sha256', key).update(body, 'utf8').digest('hex').slice(0, 32);
  // Constant-time, and checked BEFORE any claim is read: pulling the expiry out of an
  // unverified token lets an attacker steer the error message, and error messages are
  // an oracle.
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(mac, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new GuardError('token signature is invalid');
  if (tokSubject !== subject) throw new GuardError(`token was issued for '${tokSubject}', not '${subject}'`);
  const exp = Number(expText), iat = Number(iatText);
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) throw new GuardError('token timestamps are malformed');
  if (now >= exp) throw new GuardError(`token expired ${now - exp}s ago`);
  // After the signature (so an unverified token cannot probe the list) and after expiry
  // (so an already-dead token gives the more useful message).
  if (revocations) {
    if (nonce in (revocations.nonces || {})) throw new GuardError('token has been revoked');
    const epoch = (revocations.callerEpochs || {})[tokSubject];
    if (epoch !== undefined && iat < Number(epoch)) {
      throw new GuardError(`every token issued for '${tokSubject}' before ${epoch} was revoked`);
    }
  }
  const scopes = scopeText.split('+');
  if (scopeText !== '*' && !scopes.includes(scope)) {
    throw new GuardError(`token is scoped to [${scopes}] and does not cover '${scope}'`);
  }
  return { subject: tokSubject, iat, exp, nonce, scopes, expiresIn: exp - now };
}
