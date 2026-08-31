// Tests for src/guards.mjs — the controls underneath the permission profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as guards from '../src/guards.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ultron-guards-'));

// ------------------------------------------------------------------- path confinement

test('UNC and extended-length paths are refused', () => {
  for (const raw of ['\\\\server\\share\\f', '\\\\?\\C:\\x', '//server/share/x']) {
    assert.throws(() => guards.safeResolve(raw), /UNC/, raw);
  }
});

test('alternate data streams are refused', () => {
  // The visible path passes every check while the bytes go to a stream nobody inspects.
  for (const raw of ['C:\\p\\notes.txt:payload', 'notes.txt:hidden:$DATA']) {
    assert.throws(() => guards.safeResolve(raw), /alternate data stream/, raw);
  }
});

test('DOS device names are refused in any component', () => {
  for (const raw of ['C:\\p\\CON', 'C:\\p\\nul.txt', 'C:\\p\\COM1', 'C:\\p\\LPT9\\f', 'C:\\p\\aux']) {
    assert.throws(() => guards.safeResolve(raw), /Windows device/, raw);
  }
});

test('trailing dots and spaces are refused but . and .. are not', () => {
  assert.throws(() => guards.safeResolve('C:\\p\\secrets.\\key'), /trailing dots/);
  // "." and ".." legitimately consist of dots; realpath collapses them and confinement
  // judges the real target, so refusing them would break relative paths for nothing.
  assert.doesNotThrow(() => guards.safeResolve('./a/../b', tmp()));
});

test('an unresolvable 8.3 short name is refused', () => {
  assert.throws(() => guards.safeResolve('C:\\NOSUCH~1\\x'), /short name/);
});

test('a resolvable 8.3 short name is expanded rather than refused', () => {
  // A short name is only a problem if it SURVIVES resolution. Refusing ~N up front rejected
  // legitimate paths whose ancestor happens to be shortened - C:\Users\RUNNER~1\... on a CI
  // runner, or any username long enough for Windows to abbreviate. Expanding first is also
  // stronger: confinement then judges the real location instead of the abbreviation.
  if (process.platform !== 'win32') return;   // 8.3 aliases are a Windows/NTFS feature
  const resolved = guards.safeResolve('C:\\PROGRA~1\\does-not-exist-yet.txt');
  assert.ok(!/~\d/.test(resolved), `a short name survived: ${resolved}`);
  assert.match(resolved, /Program Files/);
});

test('a NUL byte is refused', () => {
  assert.throws(() => guards.safeResolve('a\0b'), /NUL byte/);
});

test('traversal resolves out and is then caught by confinement', () => {
  const root = tmp();
  const escaped = guards.safeResolve(path.join(root, '..', '..', 'elsewhere'), root);
  assert.equal(guards.insideRoots(escaped, [root]), false);
});

test('a legitimate path inside the root is accepted', () => {
  const root = tmp();
  const file = path.join(root, 'ok.txt');
  writeFileSync(file, 'x', 'utf8');
  assert.equal(guards.insideRoots(guards.safeResolve(file, root), [root]), true);
});

test('a path that does not exist yet still resolves and confines', () => {
  // Writing a new file is legitimate; it must not fail just because realpath cannot
  // resolve a target that is not there yet.
  const root = tmp();
  const target = guards.safeResolve(path.join(root, 'sub', 'new.txt'), root);
  assert.equal(guards.insideRoots(target, [root]), true);
});

test('a sibling directory sharing a name prefix is not treated as inside', () => {
  // The classic prefix bug: "C:\work" must not contain "C:\workspace".
  const base = tmp();
  const root = path.join(base, 'work');
  const sibling = path.join(base, 'workspace');
  assert.equal(guards.insideRoots(sibling, [root]), false);
});

// ------------------------------------------------------------------------- output caps

test('boundedCapture stops at the limit and reports truncation', () => {
  const sink = guards.boundedCapture(10);
  sink.push('a'.repeat(50));
  assert.equal(sink.truncated, true);
  assert.match(sink.value, /output truncated at 10 bytes/);
  assert.equal(sink.bytes, 10);
});

test('boundedCapture keeps short output verbatim', () => {
  const sink = guards.boundedCapture(1024);
  sink.push('hello');
  assert.equal(sink.value, 'hello');
  assert.equal(sink.truncated, false);
});

test('boundedCapture keeps the prefix that fits rather than discarding everything', () => {
  // A partial answer beats an empty one, and the useful signal is near the start.
  const sink = guards.boundedCapture(5);
  sink.push('abcdefghij');
  assert.match(sink.value, /^abcde/);
});

test('boundedCapture counts bytes, not characters', () => {
  const sink = guards.boundedCapture(4);
  sink.push('日本');   // 3 bytes each in UTF-8
  assert.equal(sink.truncated, true);
});

// ------------------------------------------------------------------- audit hash chain

test('a clean chain verifies', () => {
  const file = path.join(tmp(), 'audit.jsonl');
  for (let i = 0; i < 5; i += 1) guards.appendAudit(file, { event: 'run', stage: `s${i}` });
  const state = guards.verifyAudit(file);
  assert.equal(state.ok, true);
  assert.equal(state.chained, 5);
});

test('editing a record breaks the chain at that line', () => {
  const file = path.join(tmp(), 'audit.jsonl');
  for (let i = 0; i < 5; i += 1) guards.appendAudit(file, { event: 'run', stage: `s${i}` });
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const record = JSON.parse(lines[2]);
  record.stage = 'rewritten';
  lines[2] = JSON.stringify(record);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const state = guards.verifyAudit(file);
  assert.equal(state.ok, false);
  assert.equal(state.brokenAt, 3);
  assert.match(state.reason, /altered/);
});

test('deleting a record is detected', () => {
  const file = path.join(tmp(), 'audit.jsonl');
  for (let i = 0; i < 5; i += 1) guards.appendAudit(file, { event: 'run', stage: `s${i}` });
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines.splice(2, 1);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  assert.equal(guards.verifyAudit(file).ok, false);
});

test('tail truncation still verifies — only a checkpoint catches it', () => {
  // The honest limitation, asserted rather than glossed over: whoever can append can
  // also cut the tail off and continue a chain that verifies perfectly.
  const dir = tmp();
  const file = path.join(dir, 'audit.jsonl');
  for (let i = 0; i < 5; i += 1) guards.appendAudit(file, { event: 'run', stage: `s${i}` });
  const before = guards.checkpointAudit(file, path.join(dir, 'cp.jsonl'));
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  writeFileSync(file, lines.slice(0, 3).join('\n') + '\n', 'utf8');
  const after = guards.verifyAudit(file);
  assert.equal(after.ok, true, 'a truncated chain still verifies — this is the gap');
  assert.notEqual(before.head, after.head, 'but the checkpointed head no longer matches');
});

test('pre-chain history is reported as uncovered, not silently trusted', () => {
  const file = path.join(tmp(), 'audit.jsonl');
  writeFileSync(file, JSON.stringify({ ts: 'old', event: 'legacy' }) + '\n', 'utf8');
  guards.appendAudit(file, { event: 'new' });
  const state = guards.verifyAudit(file);
  assert.equal(state.ok, true);
  assert.equal(state.legacy, 1);
  assert.equal(state.chained, 1);
});

test('checkpointing a broken chain is refused', () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.jsonl');
  guards.appendAudit(file, { event: 'a' });
  writeFileSync(file, readFileSync(file, 'utf8').replace('"a"', '"b"'), 'utf8');
  assert.throws(() => guards.checkpointAudit(file, path.join(dir, 'cp.jsonl')), guards.GuardError);
});

test('canonicalJson sorts keys and emits no incidental whitespace', () => {
  // This is the exact contract that lets Alfred verify a chain Ultron wrote.
  assert.equal(guards.canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
});

// --------------------------------------------------------------------------- redaction

test('non-allowlisted values are withheld but their names are kept', () => {
  const out = guards.redact({ pipeline: 'feature', apiKey: 'abcd' }, ['pipeline']);
  assert.equal(out.pipeline, 'feature');
  assert.equal(out.apiKey, guards.REDACTED);
  assert.ok('apiKey' in out, 'knowing the field was supplied is useful and reveals nothing');
});

test('a secret-shaped value is withheld even from an allowlisted field', () => {
  const out = guards.redact({ task: 'a'.repeat(64) }, ['task']);
  assert.equal(out.task, guards.REDACTED);
});

test('a brand new field is withheld by default', () => {
  const out = guards.redact({ brandNewThing: 'whatever' });
  assert.equal(out.brandNewThing, guards.REDACTED);
});

// ------------------------------------------------------------------------------- quota

test('a burst is allowed and then the bucket runs dry', () => {
  const file = path.join(tmp(), 'quota.json');
  for (let i = 0; i < 5; i += 1) new guards.TokenBucket(file, 1000).consume('agent', 60, 5);
  assert.throws(() => new guards.TokenBucket(file, 1000).consume('agent', 60, 5), /rate limit exceeded/);
});

test('the bucket refills over time', () => {
  const file = path.join(tmp(), 'quota.json');
  for (let i = 0; i < 5; i += 1) new guards.TokenBucket(file, 1000).consume('agent', 60, 5);
  assert.equal(new guards.TokenBucket(file, 1002).consume('agent', 60, 5).limited, true);
});

test('keys have independent buckets', () => {
  const file = path.join(tmp(), 'quota.json');
  for (let i = 0; i < 3; i += 1) new guards.TokenBucket(file, 1000).consume('a', 60, 3);
  assert.equal(new guards.TokenBucket(file, 1000).consume('b', 60, 3).limited, true);
});

test('no limit configured means no limiting', () => {
  assert.equal(new guards.TokenBucket(path.join(tmp(), 'q.json')).consume('owner', 0).limited, false);
});

test('a corrupt quota file does not deny everything', () => {
  // Fail-closed is right for authorization and wrong for a quota file: a torn write must
  // not lock the user out of their own tool.
  const file = path.join(tmp(), 'quota.json');
  writeFileSync(file, '{not json', 'utf8');
  assert.equal(new guards.TokenBucket(file, 1000).consume('agent', 60, 5).limited, true);
});

// ---------------------------------------------------------------------- confinement argv

test('windows gets no argv-level confinement, and says so', () => {
  // The honest branch. Returning an unchanged argv without a note would let a caller assume
  // the limits applied.
  const r = guards.confineArgv(['cmd', 'a'], { memoryBytes: 1024 }, { platform: 'win32' });
  assert.deepEqual(r.argv, ['cmd', 'a']);
  assert.deepEqual(r.applied, []);
  assert.match(r.note, /no argv-level confinement/);
});

test('rlimits are applied by wrapping argv with prlimit', () => {
  const r = guards.confineArgv(['python3', '-c', 'x'], {
    memoryBytes: 67108864, cpuSeconds: 30, activeProcesses: 8, maxFileBytes: 1024,
  }, { platform: 'linux' });
  assert.equal(r.argv[0], 'prlimit');
  assert.ok(r.argv.includes('--as=67108864'));
  assert.ok(r.argv.includes('--cpu=30'));
  assert.ok(r.argv.includes('--nproc=8'));
  assert.ok(r.argv.includes('--fsize=1024'));
  // `--` then the real command, so nothing is reinterpreted as a prlimit flag.
  assert.deepEqual(r.argv.slice(r.argv.indexOf('--') + 1), ['python3', '-c', 'x']);
  assert.ok(r.applied.includes('rlimits'));
});

test('no limits means no wrapper at all', () => {
  const r = guards.confineArgv(['echo', 'hi'], {}, { platform: 'linux' });
  assert.deepEqual(r.argv, ['echo', 'hi']);
  assert.deepEqual(r.applied, []);
});

test('egress isolation wraps outermost', () => {
  const r = guards.confineArgv(['python3'], { memoryBytes: 1024 },
    { platform: 'linux', isolateNetwork: true, netnsAvailable: true });
  assert.equal(r.argv[0], 'unshare');
  assert.ok(r.argv.includes('--map-current-user'), 'must not pretend the child is root');
  assert.ok(!r.argv.includes('--map-root-user'));
  assert.ok(r.argv.indexOf('unshare') < r.argv.indexOf('prlimit'),
    'the namespace is entered before the limits are applied');
  assert.deepEqual(r.applied, ['rlimits', 'netns']);
});

test('egress isolation alone still wraps', () => {
  const r = guards.confineArgv(['curl'], {},
    { platform: 'linux', isolateNetwork: true, netnsAvailable: true });
  assert.equal(r.argv[0], 'unshare');
  assert.deepEqual(r.applied, ['netns']);
});

test('isolation requested but unavailable runs unwrapped and admits it', () => {
  // A kernel that forbids unprivileged user namespaces cannot provide this control. Wrapping
  // anyway made every isolated call fail to spawn at all - a control that becomes an outage
  // when unavailable gets switched off, which is the worst outcome. So it runs, and says so.
  const r = guards.confineArgv(['curl'], { memoryBytes: 1024 },
    { platform: 'linux', isolateNetwork: true, netnsAvailable: false });
  assert.equal(r.argv[0], 'prlimit', 'the rlimits must still apply');
  assert.ok(!r.argv.includes('unshare'));
  assert.ok(r.applied.includes('netns-unavailable'));
  assert.ok(!/netns\b/.test(r.note.replace('netns-unavailable', '')),
    'the note must not claim isolation it did not apply');
});

test('an unavailable namespace does not fake a confinement note', () => {
  const r = guards.confineArgv(['curl'], {},
    { platform: 'linux', isolateNetwork: true, netnsAvailable: false });
  assert.equal(r.note, 'no limits configured');
  assert.deepEqual(r.argv, ['curl']);
});

test('availability is always false on windows', () => {
  assert.equal(guards.networkIsolationAvailable('win32'), false);
});

test('fractional limits are floored, never passed through as decimals', () => {
  // prlimit takes integers; "--as=1024.5" would be rejected and the child would not run.
  const r = guards.confineArgv(['x'], { memoryBytes: 1024.9 }, { platform: 'linux' });
  assert.ok(r.argv.includes('--as=1024'));
});

test('profile limits tighten as the profile widens responsibility', () => {
  const ro = guards.limitsForProfile('read-only');
  const bal = guards.limitsForProfile('balanced');
  assert.ok(ro.memoryBytes < bal.memoryBytes);
  assert.ok(ro.cpuSeconds < bal.cpuSeconds);
  assert.ok(ro.activeProcesses < bal.activeProcesses);
});

test('unrestricted has no resource ceiling, deliberately', () => {
  // Same reasoning as its missing path boundary: an escape hatch that does not exist gets
  // replaced by using a broader profile for everything.
  assert.deepEqual(guards.limitsForProfile('unrestricted'), {});
  const r = guards.confineArgv(['x'], guards.limitsForProfile('unrestricted'), { platform: 'linux' });
  assert.deepEqual(r.argv, ['x']);
});

test('an unknown profile falls back to the most restrictive one', () => {
  assert.deepEqual(guards.limitsForProfile('nonsense'), guards.limitsForProfile('read-only'));
});


test('a valid token verifies for its scope', () => {
  const t = guards.mintToken('k', 'agent', ['read'], 60, 1000);
  assert.deepEqual(guards.verifyToken('k', t, 'agent', 'read', 1000).scopes, ['read']);
});

test('widening the scope invalidates the token', () => {
  // The scopes are inside the MAC, so editing them is forgery rather than escalation.
  const t = guards.mintToken('k', 'agent', ['read'], 60, 1000);
  assert.throws(() => guards.verifyToken('k', t.replace('.read.', '.read+write.'), 'agent', 'write', 1000), /signature/);
});

test('pushing the expiry out invalidates the token', () => {
  const parts = guards.mintToken('k', 'agent', ['read'], 1, 1000).split('.');
  parts[2] = '9999999999';
  assert.throws(() => guards.verifyToken('k', parts.join('.'), 'agent', 'read', 2000), /signature/);
});

test('an expired token is refused', () => {
  const t = guards.mintToken('k', 'agent', ['read'], 10, 1000);
  assert.throws(() => guards.verifyToken('k', t, 'agent', 'read', 5000), /expired/);
});

test('a token cannot be replayed as another subject', () => {
  const t = guards.mintToken('k', 'agent', ['read'], 60, 1000);
  assert.throws(() => guards.verifyToken('k', t, 'other', 'read', 1000), /issued for/);
});

test('a different key cannot mint an acceptable token', () => {
  const t = guards.mintToken('attacker', 'agent', ['read'], 60, 1000);
  assert.throws(() => guards.verifyToken('k', t, 'agent', 'read', 1000), /signature/);
});

test('two tokens minted in the same second differ', () => {
  const a = guards.mintToken('k', 'agent', ['read'], 60, 1000);
  const b = guards.mintToken('k', 'agent', ['read'], 60, 1000);
  assert.notEqual(a, b);
});

test('a wildcard token covers any scope', () => {
  const t = guards.mintToken('k', 'owner', [], 60, 1000);
  assert.deepEqual(guards.verifyToken('k', t, 'owner', 'anything', 1000).scopes, ['*']);
});

test('a token carries its issue time', () => {
  // Needed for whole-subject revocation; asserted so it cannot be dropped.
  const claims = guards.verifyToken('k', guards.mintToken('k', 'agent', ['read'], 60, 1000), 'agent', 'read', 1000);
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp, 1060);
});

test('editing the issue time invalidates the token', () => {
  // Otherwise a revoked generation could re-date itself out of the revocation.
  const parts = guards.mintToken('k', 'agent', ['read'], 60, 1000).split('.');
  parts[2] = '9999999999';
  assert.throws(() => guards.verifyToken('k', parts.join('.'), 'agent', 'read', 1000), /signature/);
});

test('a revoked nonce stops working', () => {
  // Expiry alone is not revocation: a token leaked at minute one of a one-hour TTL is
  // usable for 59 minutes unless something can say "not that one".
  const t = guards.mintToken('k', 'agent', ['read'], 600, 1000);
  const nonce = guards.verifyToken('k', t, 'agent', 'read', 1000).nonce;
  assert.throws(
    () => guards.verifyToken('k', t, 'agent', 'read', 1010, { nonces: { [nonce]: 1600 } }),
    /revoked/
  );
});

test('revoking a subject kills every token issued before the epoch', () => {
  const t = guards.mintToken('k', 'agent', ['read'], 600, 1000);
  assert.throws(
    () => guards.verifyToken('k', t, 'agent', 'read', 1100, { callerEpochs: { agent: 1050 } }),
    /was revoked/
  );
});

test('a token issued after the epoch survives a subject revocation', () => {
  // Revoking a subject must not permanently disable it, or the response to a leak is an outage.
  const t = guards.mintToken('k', 'agent', ['read'], 600, 1100);
  assert.equal(guards.verifyToken('k', t, 'agent', 'read', 1110, { callerEpochs: { agent: 1050 } }).iat, 1100);
});

test('revoking one subject does not affect another', () => {
  const t = guards.mintToken('k', 'scheduled', ['read'], 600, 1000);
  assert.equal(guards.verifyToken('k', t, 'scheduled', 'read', 1100, { callerEpochs: { agent: 1050 } }).scopes[0], 'read');
});

test('an expired token reports expiry rather than revocation', () => {
  // Order matters for the error message: an already-dead token gives the more useful one.
  const t = guards.mintToken('k', 'agent', ['read'], 10, 1000);
  const nonce = guards.verifyToken('k', t, 'agent', 'read', 1001).nonce;
  assert.throws(
    () => guards.verifyToken('k', t, 'agent', 'read', 5000, { nonces: { [nonce]: 9999 } }),
    /expired/
  );
});
