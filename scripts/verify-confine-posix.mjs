// End-to-end verification of Ultron's confinement, ON LINUX, through the real code path.
//
// The previous iteration could only verify this in two halves: the wrappers (prlimit/unshare)
// with Python, and the argv Ultron builds with a unit test. The composition was reasoned rather
// than observed, because Node was not installed in WSL. It is now, so this closes that gap by
// driving `runCommand` and `runHook` for real and watching the kernel refuse.
//
//   wsl -e ~/node-v22.14.0-linux-x64/bin/node /mnt/c/projects/ultron-cli/scripts/verify-confine-posix.mjs
//
// Deliberately in scripts/ rather than test/: `node --test` collects everything under test/,
// and on Windows every check here would be a vacuous no-op reported as a failure.

import { runCommand } from '../src/process.mjs';
import { runHook } from '../src/hooks.mjs';
import * as guards from '../src/guards.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(name);
};

if (process.platform === 'win32') {
  console.log('This must run on Linux; on Windows every check would be a vacuous pass.');
  process.exit(1);
}

const ALLOC = 'b = bytearray(400*1024*1024); print(len(b))';
const NET = "import socket; s=socket.socket(); s.settimeout(4); print('CONNECT', s.connect_ex(('1.1.1.1',80)))";

console.log('--- runCommand: resource ceilings ---');

// Control first. If the unconfined allocation fails, nothing below means anything.
try {
  const r = await runCommand('python3', ['-c', ALLOC], { timeoutMs: 90000 });
  check('CONTROL: a 400MB allocation succeeds unconfined', r.stdout.includes('419430400'), r.stdout.slice(0, 30));
} catch (e) {
  check('CONTROL: a 400MB allocation succeeds unconfined', false, String(e.message).slice(0, 60));
}

try {
  await runCommand('python3', ['-c', ALLOC], { timeoutMs: 90000, limits: { memoryBytes: 64 * 1024 * 1024 } });
  check('a memory ceiling refuses an over-limit allocation', false, 'it succeeded');
} catch (e) {
  check('a memory ceiling refuses an over-limit allocation', /MemoryError/.test(e.message),
    String(e.message).split('\n').pop().slice(0, 46));
}

try {
  const r = await runCommand('python3', ['-c', "print('ok')"], {
    timeoutMs: 60000, limits: guards.limitsForProfile('read-only'),
  });
  check('a confined child still runs normally', r.stdout === 'ok', r.stdout.slice(0, 20));
  check('the confinement note reports what was applied', /rlimits/.test(r.confinement), r.confinement);
} catch (e) {
  check('a confined child still runs normally', false, String(e.message).slice(0, 60));
}

try {
  await runCommand('python3', ['-c', "open('/tmp/ultron-e2e-fsize','wb').write(b'x'*10000000)"], {
    timeoutMs: 60000, limits: { maxFileBytes: 1024 },
  });
  check('a file-size ceiling refuses an over-limit write', false, 'it succeeded');
} catch {
  check('a file-size ceiling refuses an over-limit write', true);
}

console.log('\n--- runCommand: egress ---');

let controlHasNet = false;
try {
  const r = await runCommand('python3', ['-c', NET], { timeoutMs: 60000 });
  controlHasNet = r.stdout.includes('CONNECT 0');
  check('CONTROL: the probe reaches the network unisolated', controlHasNet, r.stdout.slice(0, 24));
} catch (e) {
  check('CONTROL: the probe reaches the network unisolated', false, String(e.message).slice(0, 40));
}

try {
  const r = await runCommand('python3', ['-c', NET], {
    timeoutMs: 60000, isolateNetwork: true, limits: { memoryBytes: 256 * 1024 * 1024 },
  });
  check('an isolated child cannot reach the network', !r.stdout.includes('CONNECT 0'), r.stdout.slice(0, 24));
  check('the note reports egress isolation', /netns/.test(r.confinement), r.confinement);
} catch (e) {
  check('an isolated child cannot reach the network', false, String(e.message).slice(0, 60));
}

try {
  const r = await runCommand('python3', ['-c', 'import os; print("uid", os.getuid())'], {
    timeoutMs: 60000, isolateNetwork: true,
  });
  check('an isolated child keeps its real uid', !r.stdout.includes('uid 0'), r.stdout.slice(0, 20));
} catch (e) {
  check('an isolated child keeps its real uid', false, String(e.message).slice(0, 60));
}

console.log('\n--- runHook: the most frequently executed untrusted thing ---');

const hook = (over = {}) => ({ command: 'python3', args: ['-c', 'print("hook ran")'], matcher: null, timeoutMs: 30000, canDeny: false, ...over });

let r = await runHook(hook(), {}, { limits: guards.limitsForProfile('read-only') });
check('a confined hook runs and reports ok', r.ok && r.stdout.includes('hook ran'), `ok=${r.ok}`);
check('the hook records its confinement', /rlimits/.test(r.confinement || ''), r.confinement);

r = await runHook(hook({ args: ['-c', ALLOC] }), {}, { limits: { memoryBytes: 64 * 1024 * 1024 } });
check('a hook cannot exceed its memory ceiling', !r.ok, `ok=${r.ok} exit=${r.exitCode}`);

r = await runHook(hook({ args: ['-c', NET] }), {}, { isolateNetwork: true });
check('an isolated hook cannot reach the network', !r.stdout.includes('CONNECT 0'), r.stdout.trim().slice(0, 24));

r = await runHook(hook({ args: ['-c', 'import sys; sys.stdout.write("x"*5000000)'] }), {});
check('hook output is still capped', r.stdout.length < 2 * 1024 * 1024, `${r.stdout.length} bytes`);

console.log();
if (!controlHasNet) {
  console.log('WARNING: this machine had no outbound network, so the egress checks are not conclusive.');
}
if (failures.length) {
  console.log(`${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL ULTRON POSIX CONFINEMENT CHECKS PASSED (end to end, real code path)');
