import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { completion, commands, providerNames, subcommands } from '../src/completions.mjs';
import { providers } from '../src/providers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const routerSource = await fs.readFile(path.join(ROOT, 'bin', 'ultron.mjs'), 'utf8');

test('every completion command is actually handled by the router', () => {
  const missing = commands.filter(c => c !== 'help' && !routerSource.includes(`cmd === '${c}'`));
  assert.deepEqual(missing, [], `completions advertise commands the router does not handle: ${missing.join(', ')}`);
});

test('every router command is offered in completions', () => {
  const handled = [...routerSource.matchAll(/cmd === '([a-z-]+)'/g)].map(m => m[1]);
  // `--help` is a flag alias for `help`, not a command in its own right.
  const undocumented = [...new Set(handled)].filter(c => !c.startsWith('--') && !commands.includes(c));
  assert.deepEqual(undocumented, [], `router handles commands missing from completions: ${undocumented.join(', ')}`);
});

test('completion provider list matches the real provider table', () => {
  assert.deepEqual([...providerNames].sort(), Object.keys(providers).sort());
});

test('the new v0.5.0 commands are present', () => {
  for (const cmd of ['agents', 'pipeline', 'registry', 'route', 'notion']) {
    assert.ok(commands.includes(cmd), `${cmd} missing from completions`);
  }
  assert.deepEqual(subcommands.pipeline, ['plan', 'graph', 'run']);
  for (const sub of ['login', 'status', 'logout', 'tools', 'call']) {
    assert.ok(subcommands.notion.includes(sub), `notion ${sub} missing`);
  }
});

test('each supported shell emits usable, non-empty completions', () => {
  for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
    const output = completion(shell);
    assert.ok(output.length > 50, `${shell} output too short`);
    assert.ok(output.includes('ultron'), `${shell} output does not reference ultron`);
    assert.ok(output.includes('pipeline'), `${shell} output missing the pipeline command`);
    assert.ok(output.includes('deepseek') || output.includes('plan graph run'), `${shell} output missing new values`);
    assert.ok(output.endsWith('\n'), `${shell} output should end with a newline`);
  }
});

test('bash and powershell complete subcommands contextually', () => {
  const bash = completion('bash');
  assert.match(bash, /pipeline\)\s*COMPREPLY.*plan graph run/s);
  assert.match(bash, /--provider\)/);
  const pwsh = completion('powershell');
  assert.match(pwsh, /pipeline\\s\+/);
  assert.match(pwsh, /login status logout tools call/);
  assert.match(pwsh, /CompletionResult/, 'powershell should emit proper completion results');
});

test('fish scopes subcommands to their parent command', () => {
  const fish = completion('fish');
  assert.match(fish, /__fish_use_subcommand/);
  assert.match(fish, /__fish_seen_subcommand_from pipeline/);
  assert.match(fish, /__fish_seen_subcommand_from notion/);
});

test('an unsupported shell is rejected', () => {
  assert.throws(() => completion('nushell'), /Unsupported shell/);
  assert.throws(() => completion(undefined), /Unsupported shell/);
});
