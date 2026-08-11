import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHookConfig, matches, runHook, fireHooks, guardToolUse, HOOK_EVENTS } from '../src/hooks.mjs';

// A fake child process: records what it was spawned with and what arrived on stdin.
function fakeSpawn({ exitCode = 0, stderr = '', stdout = '', delayMs = 0, throwOnSpawn = false, record = {} } = {}) {
  return (command, args, options) => {
    if (throwOnSpawn) throw new Error('ENOENT');
    record.command = command; record.args = args; record.options = options; record.stdin = '';
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { end: value => { record.stdin = value; } };
    child.kill = () => { record.killed = true; };
    if (delayMs === Infinity) return child; // never finishes -> exercises the timeout
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    }, delayMs);
    return child;
  };
}

const hook = extra => ({ command: 'node', args: ['guard.mjs'], matcher: null, timeoutMs: 200, canDeny: false, ...extra });

test('all four lifecycle events are supported', () => {
  assert.deepEqual(HOOK_EVENTS, ['sessionStart', 'preToolUse', 'postToolUse', 'sessionEnd']);
});

test('a missing hook config is not an error', async () => {
  const config = await loadHookConfig(path.join(os.tmpdir(), 'ultron-no-hooks-here'));
  assert.deepEqual(config.hooks, {});
});

test('hook config is parsed, normalized, and validated', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-hooks-'));
  await fs.mkdir(path.join(dir, '.ultron'), { recursive: true });
  await fs.writeFile(path.join(dir, '.ultron', 'hooks.json'), JSON.stringify({
    preToolUse: [{ matcher: 'fileWrite', command: 'node', args: ['g.mjs'], timeoutMs: 1234, canDeny: true }],
    postToolUse: [{ command: 'node' }],
    bogusEvent: [{ command: 'x' }]
  }));
  const config = await loadHookConfig(dir);
  assert.equal(config.hooks.preToolUse[0].canDeny, true);
  assert.equal(config.hooks.preToolUse[0].timeoutMs, 1234);
  assert.equal(config.hooks.postToolUse[0].timeoutMs, 5000, 'default timeout applied');
  assert.deepEqual(config.unknownEvents, ['bogusEvent']);
  // canDeny is only meaningful on preToolUse
  assert.equal(config.hooks.postToolUse[0].canDeny, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a hook entry without a command is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-hooks-bad-'));
  await fs.mkdir(path.join(dir, '.ultron'), { recursive: true });
  await fs.writeFile(path.join(dir, '.ultron', 'hooks.json'), JSON.stringify({ preToolUse: [{ args: ['x'] }] }));
  await assert.rejects(() => loadHookConfig(dir), /needs a string "command"/);
  await fs.writeFile(path.join(dir, '.ultron', 'hooks.json'), JSON.stringify({ preToolUse: [{ command: 'n', args: 'oops' }] }));
  await assert.rejects(() => loadHookConfig(dir), /args must be an array/);
  await fs.writeFile(path.join(dir, '.ultron', 'hooks.json'), '{ not json');
  await assert.rejects(() => loadHookConfig(dir), /Invalid hook config/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('matcher selects hooks by tool name', () => {
  assert.equal(matches(hook({ matcher: null }), 'anything'), true);
  assert.equal(matches(hook({ matcher: '*' }), 'anything'), true);
  assert.equal(matches(hook({ matcher: 'fileWrite' }), 'fileWrite'), true);
  assert.equal(matches(hook({ matcher: 'fileWrite' }), 'shell'), false);
  assert.equal(matches(hook({ matcher: 'fileWrite' }), undefined), false);
});

test('the payload is delivered on STDIN as JSON, never in argv', async () => {
  const record = {};
  const result = await runHook(hook(), { tool: 'shell', input: 'rm -rf / && echo pwned' }, { spawnImpl: fakeSpawn({ record }) });
  assert.equal(result.ok, true);
  assert.deepEqual(record.args, ['guard.mjs'], 'argv must not carry the payload');
  const delivered = JSON.parse(record.stdin);
  assert.equal(delivered.input, 'rm -rf / && echo pwned');
  assert.equal(record.options.shell, false, 'hooks must never run through a shell');
});

test('a non-zero exit is reported but does not throw', async () => {
  const result = await runHook(hook(), {}, { spawnImpl: fakeSpawn({ exitCode: 3, stderr: 'nope' }) });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /nope/);
});

test('a spawn failure is captured rather than crashing', async () => {
  const result = await runHook(hook(), {}, { spawnImpl: fakeSpawn({ throwOnSpawn: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'spawn-failed');
});

test('a hook that never finishes is killed at its timeout', async () => {
  const record = {};
  const result = await runHook(hook({ timeoutMs: 30 }), {}, { spawnImpl: fakeSpawn({ delayMs: Infinity, record }) });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(record.killed, true, 'the child must be killed');
});

test('a canDeny preToolUse hook vetoes the tool call', async () => {
  const config = { hooks: { preToolUse: [hook({ canDeny: true })] } };
  const outcome = await fireHooks(config, 'preToolUse', { tool: 'fileWrite' }, { spawnImpl: fakeSpawn({ exitCode: 1, stderr: 'path is protected' }) });
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.denials.length, 1);
  assert.match(outcome.denials[0].reason, /path is protected/);
});

test('a failing hook WITHOUT canDeny cannot veto', async () => {
  const config = { hooks: { preToolUse: [hook({ canDeny: false })] } };
  const outcome = await fireHooks(config, 'preToolUse', { tool: 'fileWrite' }, { spawnImpl: fakeSpawn({ exitCode: 1 }) });
  assert.equal(outcome.allowed, true, 'only canDeny hooks may veto');
  assert.equal(outcome.results[0].ok, false, 'the failure is still reported');
});

test('a canDeny hook that times out is treated as a DENY (fail closed)', async () => {
  const config = { hooks: { preToolUse: [hook({ canDeny: true, timeoutMs: 20 })] } };
  const outcome = await fireHooks(config, 'preToolUse', { tool: 'shell' }, { spawnImpl: fakeSpawn({ delayMs: Infinity }) });
  assert.equal(outcome.allowed, false);
  assert.match(outcome.denials[0].reason, /timed out.*treated as deny/);
});

test('hooks whose matcher does not match are not run at all', async () => {
  let spawned = 0;
  const config = { hooks: { preToolUse: [hook({ matcher: 'fileWrite', canDeny: true })] } };
  const outcome = await fireHooks(config, 'preToolUse', { tool: 'shell' }, {
    spawnImpl: (...args) => { spawned++; return fakeSpawn({ exitCode: 1 })(...args); }
  });
  assert.equal(spawned, 0);
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.results.length, 0);
});

test('an event with no hooks is trivially allowed', async () => {
  const outcome = await fireHooks({ hooks: {} }, 'preToolUse', { tool: 'shell' });
  assert.deepEqual(outcome, { allowed: true, denials: [], results: [] });
});

test('guardToolUse throws with the denial reasons', async () => {
  const config = { hooks: { preToolUse: [hook({ canDeny: true })] } };
  await assert.rejects(
    () => guardToolUse(config, 'fileWrite', { path: 'x' }, { spawnImpl: fakeSpawn({ exitCode: 1, stderr: 'denied by policy' }) }),
    /Tool "fileWrite" denied by hook\(s\).*denied by policy/
  );
});

test('guardToolUse resolves when allowed', async () => {
  const config = { hooks: { preToolUse: [hook({ canDeny: true })] } };
  const outcome = await guardToolUse(config, 'fileWrite', {}, { spawnImpl: fakeSpawn({ exitCode: 0 }) });
  assert.equal(outcome.allowed, true);
});
