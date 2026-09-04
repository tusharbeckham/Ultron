import { spawn } from 'node:child_process';
import { boundedCapture, confineArgv } from './guards.mjs';

// Output is capped. `out += d` on a child that writes gigabytes takes the CLI down with it,
// and the size of a command's output usually depends on the state of the machine rather than
// on anything the caller chose — so it is not a case you can rule out by only running trusted
// commands.
const OUTPUT_LIMIT = 4 * 1024 * 1024;

export function runCommand(command, args, {
  cwd = process.cwd(), env = process.env, timeoutMs = 600000,
  outputLimit = OUTPUT_LIMIT, limits = null, isolateNetwork = false,
} = {}) {
  return new Promise((resolve, reject) => {
    // Resource ceilings and egress isolation are applied by wrapping argv (see confineArgv).
    // Still shell: false — the wrapper is an argv array and the real command follows it.
    const { argv, note } = confineArgv([command, ...args], limits || {}, { isolateNetwork });
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out = boundedCapture(outputLimit), err = boundedCapture(outputLimit);
    let settled = false;
    const finish = fn => (...a) => { if (settled) return; settled = true; clearTimeout(timer); fn(...a); };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGTERM then reject. The child is also killed on the hard path below so a
      // process that ignores SIGTERM cannot outlive the call that started it.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Not unref'd, for the same reason as in hooks.mjs: this is the timer that enforces the
    // timeout, and an unref'd timer cannot keep the loop alive to fire. It is cleared on every
    // settle path. The SIGKILL escalation above IS unref'd, correctly - that one is
    // fire-and-forget cleanup and has no business holding the process open.

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', finish(e => reject(e)));
    child.on('close', finish(code => {
      if (code === 0) {
        resolve({ stdout: out.value.trim(), stderr: err.value.trim(), truncated: out.truncated || err.truncated, confinement: note });
      } else {
        reject(new Error(err.value.trim() || `${command} exited ${code}`));
      }
    }));
  });
}

export async function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try { await runCommand(checker, [command], { timeoutMs: 3000 }); return true; } catch { return false; }
}
