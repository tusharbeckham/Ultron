// Lifecycle hooks. Payloads go to the child on STDIN as JSON, never in argv, so no
// untrusted value can reach a command line. Every hook is timeout-bounded. Only a
// preToolUse hook marked canDeny may veto a tool call.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { boundedCapture, confineArgv } from './guards.mjs';

export const HOOK_EVENTS = Object.freeze(['sessionStart', 'preToolUse', 'postToolUse', 'sessionEnd']);
const DEFAULT_TIMEOUT_MS = 5000;

// A hook is a user-supplied program. Accumulating its output without a bound turns
// "the hook printed a lot" into "the CLI ran out of memory", and a preToolUse hook runs
// on every single tool call — so a chatty hook is not an unusual case, it is the
// expected one. 1 MiB is far more than any veto decision needs to explain itself.
const HOOK_OUTPUT_LIMIT = 1024 * 1024;

export async function loadHookConfig(root = process.cwd(), { file } = {}) {
  const target = file || path.join(root, '.ultron', 'hooks.json');
  let raw;
  try { raw = await fs.readFile(target, 'utf8'); } catch { return { path: target, hooks: {} }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`Invalid hook config ${target}: ${error.message}`); }
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(parsed[event]) ? parsed[event] : [];
    hooks[event] = list.map((entry, index) => {
      if (!entry?.command || typeof entry.command !== 'string') throw new Error(`${target}: ${event}[${index}] needs a string "command"`);
      if (entry.args != null && !Array.isArray(entry.args)) throw new Error(`${target}: ${event}[${index}].args must be an array`);
      return {
        command: entry.command,
        args: entry.args ? entry.args.map(String) : [],
        matcher: entry.matcher || null,
        timeoutMs: Number(entry.timeoutMs || DEFAULT_TIMEOUT_MS),
        canDeny: event === 'preToolUse' && !!entry.canDeny
      };
    });
  }
  const unknown = Object.keys(parsed).filter(k => !HOOK_EVENTS.includes(k));
  return { path: target, hooks, unknownEvents: unknown };
}

export function matches(hook, toolName) {
  if (!hook.matcher) return true;
  if (!toolName) return false;
  if (hook.matcher === '*') return true;
  return hook.matcher === toolName;
}

/** Run one hook. Never throws: a failure is data, so a broken hook cannot kill the session. */
export function runHook(hook, payload, { spawnImpl = spawn, cwd = process.cwd(), env = process.env,
                                        limits = null, isolateNetwork = false } = {}) {
  return new Promise(resolve => {
    let child;
    // A hook is a user-supplied program that runs on EVERY tool call, which makes it the most
    // frequently executed untrusted thing in the CLI. Wrapping argv with prlimit/unshare keeps
    // it argv-only and shell-free while giving it a ceiling on Linux.
    const { argv, note } = confineArgv([hook.command, ...hook.args], limits || {}, { isolateNetwork });
    try {
      child = spawnImpl(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, timedOut: false, exitCode: null, stdout: '', stderr: String(error.message || error), error: 'spawn-failed', confinement: note });
      return;
    }
    let stdout = boundedCapture(HOOK_OUTPUT_LIMIT), stderr = boundedCapture(HOOK_OUTPUT_LIMIT);
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ok: false, timedOut: true, exitCode: null, stdout: stdout.value, stderr: stderr.value, error: 'timeout', confinement: note });
    }, hook.timeoutMs);
    // Deliberately NOT unref'd. This is the timer that *enforces* the timeout, and an unref'd
    // timer does not keep the event loop alive - so if nothing else does, Node exits and this
    // promise never settles. In production a real child process happens to hold the loop open,
    // which is why it appeared to work; "works because something unrelated keeps the loop
    // alive" is not a guarantee. Linux CI surfaced it as 8 cancelled tests, because the fake
    // spawn used there holds nothing open. It is cleared on every settle path below, so not
    // unref'ing cannot hold the process open past the hook.

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => { stdout.push(chunk); });
    child.stderr?.on('data', chunk => { stderr.push(chunk); });
    child.on('error', error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve({ ok: false, timedOut: false, exitCode: null, stdout: stdout.value, stderr: String(error.message || error), error: 'spawn-failed' });
    });
    child.on('close', code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      // `confinement` is reported on EVERY resolve path, not just the failures. It was
      // originally only on the spawn-failed branch, which meant a hook that ran successfully
      // said nothing about whether it had been confined — so the one case you would actually
      // want to audit was the one case with no record of it. Caught by the end-to-end Linux
      // verification, not by a unit test.
      resolve({ ok: code === 0, timedOut: false, exitCode: code, stdout: stdout.value, stderr: stderr.value, truncated: stdout.truncated || stderr.truncated, confinement: note });
    });

    // The payload goes on stdin — never interpolated into a command line.
    try { child.stdin?.end(JSON.stringify(payload ?? {})); } catch { /* child already exited */ }
  });
}

/**
 * Fire every hook registered for an event.
 * Returns { allowed, denials[], results[] }. A canDeny preToolUse hook that exits non-zero
 * (or times out) vetoes the tool call — timeout is treated as a deny, deliberately.
 */
export async function fireHooks(config, event, payload = {}, options = {}) {
  const hooks = (config?.hooks?.[event] || []).filter(h => matches(h, payload.tool));
  const results = [], denials = [];
  for (const hook of hooks) {
    const result = await runHook(hook, { event, ...payload }, options);
    const entry = { command: hook.command, args: hook.args, canDeny: hook.canDeny, ...result };
    results.push(entry);
    if (hook.canDeny && !result.ok) {
      denials.push({
        command: hook.command,
        reason: result.timedOut ? `hook timed out after ${hook.timeoutMs}ms (treated as deny)` : (result.stderr.trim() || `hook exited ${result.exitCode}`)
      });
    }
  }
  return { allowed: denials.length === 0, denials, results };
}

/** Convenience gate: throws with the collected reasons when a tool call is vetoed. */
export async function guardToolUse(config, tool, input, options = {}) {
  const outcome = await fireHooks(config, 'preToolUse', { tool, input }, options);
  if (!outcome.allowed) {
    throw new Error(`Tool "${tool}" denied by hook(s): ${outcome.denials.map(d => `${d.command}: ${d.reason}`).join('; ')}`);
  }
  return outcome;
}
