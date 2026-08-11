#!/usr/bin/env node
// Example preToolUse guard hook (canDeny: true).
//
// The tool-call payload arrives on STDIN as JSON — never in argv — so nothing here can be
// shell-injected. Exit 0 to allow, non-zero to VETO the tool call. A timeout also vetoes.
//
// This default guard is permissive by design: it blocks nothing, it just demonstrates the
// contract and shows where to put a real rule. Edit it to enforce your own policy.

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {
    console.error('guard: unreadable payload — denying to fail closed');
    process.exit(1);
  }

  const { event, tool, input = {} } = payload;

  // Example rule: never let a subagent stage run under an agent whose name looks like a
  // shell command. Replace with rules that matter to you.
  if (tool === 'subagent' && typeof input.agent === 'string' && /[;&|`$]/.test(input.agent)) {
    console.error(`guard: refusing suspicious agent name "${input.agent}"`);
    process.exit(1);
  }

  console.log(JSON.stringify({ allowed: true, event, tool }));
  process.exit(0);
});
