import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runInteractiveChat, handleChatCommand } from '../src/interactive.mjs';
import { Conversation } from '../src/chat.mjs';
import { loadSession } from '../src/sessions.mjs';
import { providers, alfredBase, alfredModel } from '../src/providers.mjs';
import { getModel, recommendTier } from '../src/models.mjs';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ultron-repl-'));

/** Drive the REPL with a scripted list of lines and capture everything it printed. */
async function drive(lines, { ask, provider = 'alfred', model = 'alfred-coder-7b', sessionDir, opening = '' } = {}) {
  const input = new PassThrough();
  let output = '';
  const sink = new Writable({ write(chunk, _enc, cb) { output += chunk.toString(); cb(); } });
  sink.isTTY = false;
  const running = runInteractiveChat({
    provider, model, sessionId: 'repl-session', stream: false, input, output: sink,
    sessionDir, opening, providerExists: name => !!providers[name] || name === 'fake',
    ask: ask || (async () => ({ provider, model, text: 'ok', usage: { inputTokens: 3, outputTokens: 2 } }))
  });
  for (const line of lines) { input.write(`${line}\n`); await new Promise(r => setTimeout(r, 40)); }
  await new Promise(r => setTimeout(r, 60));
  input.end();
  const stats = await running;
  return { output, stats };
}

test('alfred is a registered provider defaulting to the local Alfred-Coder', () => {
  assert.ok(providers.alfred, 'alfred provider exists');
  assert.equal(providers.alfred.configured(), true, 'needs no API key');
  assert.equal(providers.alfred.capabilities.free, true);
  assert.equal(providers.alfred.capabilities.streaming, true);
  assert.equal(alfredModel(), 'alfred-coder-7b');
  assert.match(alfredBase(), /^http:\/\/localhost:1234\/v1$/);
});

test('ALFRED_MODEL and ALFRED_BASE_URL override the defaults', () => {
  process.env.ALFRED_MODEL = 'my-tuned-coder';
  process.env.ALFRED_BASE_URL = 'http://127.0.0.1:11434/v1/';
  assert.equal(alfredModel(), 'my-tuned-coder');
  assert.equal(alfredBase(), 'http://127.0.0.1:11434/v1');
  delete process.env.ALFRED_MODEL; delete process.env.ALFRED_BASE_URL;
});

test('alfred-coder-7b is in the registry as the free tier-0 model', () => {
  const model = getModel('alfred-coder-7b');
  assert.equal(model.provider, 'alfred');
  assert.equal(model.tier, 0);
  assert.equal(model.inputUsdPerMillion, 0);
  assert.equal(model.outputUsdPerMillion, 0);
  assert.equal(recommendTier('fix a typo').modelId, 'alfred-coder-7b', 'trivial work routes to Alfred-Coder');
});

test('the REPL holds a multi-turn conversation and feeds history back', async () => {
  const dir = await temp();
  const seen = [];
  const { output } = await drive(['what is 2+2?', 'what did I just ask?', '/exit'], {
    sessionDir: dir,
    ask: async request => { seen.push(request.messages); return { provider: 'alfred', model: 'alfred-coder-7b', text: `reply ${seen.length}`, usage: { inputTokens: 10, outputTokens: 4 } }; }
  });
  assert.equal(seen.length, 2, 'both turns reached the model');
  assert.ok(seen[1].some(m => m.role === 'assistant' && m.content === 'reply 1'), 'turn 2 carried turn 1 in context');
  assert.ok(seen[1].some(m => m.role === 'user' && m.content === 'what is 2+2?'), 'turn 2 carried the first question');
  assert.match(output, /ULTRON interactive/);
  assert.match(output, /alfred:alfred-coder-7b/, 'the active model is shown');
  assert.match(output, /10→4 tok/, 'per-turn token usage is reported');
  const records = await loadSession('repl-session', dir);
  assert.equal(records.length, 2, 'both turns persisted for resume');
  await fs.rm(dir, { recursive: true, force: true });
});

test('an opening prompt is answered, then the REPL stays open', async () => {
  const dir = await temp();
  const asked = [];
  const { output } = await drive(['follow-up question', '/exit'], {
    sessionDir: dir, opening: 'write a regex for an email',
    ask: async request => { asked.push(request.prompt); return { provider: 'alfred', model: 'alfred-coder-7b', text: 'ok', usage: null }; }
  });
  assert.deepEqual(asked, ['write a regex for an email', 'follow-up question'], 'opening prompt ran first, REPL continued');
  assert.match(output, /write a regex for an email/, 'the opening prompt is echoed like a typed turn');
  await fs.rm(dir, { recursive: true, force: true });
});

test('the REPL exits cleanly when stdin closes instead of erroring', async () => {
  const dir = await temp();
  // No /exit — stdin just ends. Must not print "readline was closed".
  const { output } = await drive(['hello'], { sessionDir: dir });
  assert.ok(!/readline was closed/i.test(output), `clean exit expected, got: ${output}`);
  assert.ok(!/^error/im.test(output.replace(/.*ULTRON interactive.*/g, '')), 'no error line on clean exit');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a provider error does not kill the session', async () => {
  const dir = await temp();
  let calls = 0;
  const { output } = await drive(['first', 'second', '/exit'], {
    sessionDir: dir,
    ask: async () => { calls++; if (calls === 1) throw new Error('model unreachable'); return { provider: 'alfred', model: 'alfred-coder-7b', text: 'recovered', usage: null }; }
  });
  assert.equal(calls, 2, 'the REPL kept going after the failure');
  assert.match(output, /error model unreachable/);
  assert.match(output, /recovered/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('/model reports without clearing, and can switch or reset', async () => {
  const conversation = new Conversation({ provider: 'alfred', model: 'alfred-coder-7b', sessionId: 's' });
  const written = [];
  const output = { write: text => written.push(text) };

  await handleChatCommand({ name: 'model', argument: null }, { conversation, output });
  assert.equal(conversation.model, 'alfred-coder-7b', '/model alone must NOT clear the model');
  assert.match(written.at(-1), /alfred-coder-7b/);

  await handleChatCommand({ name: 'model', argument: 'deepseek-v4-flash' }, { conversation, output });
  assert.equal(conversation.model, 'deepseek-v4-flash');

  await handleChatCommand({ name: 'model', argument: 'default' }, { conversation, output });
  assert.equal(conversation.model, null, '/model default clears the override');
});

test('/provider switches only to real providers', async () => {
  const conversation = new Conversation({ provider: 'alfred', sessionId: 's' });
  const output = { write: () => {} };
  await handleChatCommand({ name: 'provider', argument: 'deepseek' }, { conversation, output, providerExists: n => !!providers[n] });
  assert.equal(conversation.provider, 'deepseek');
  await assert.rejects(
    () => handleChatCommand({ name: 'provider', argument: 'nonsense' }, { conversation, output, providerExists: n => !!providers[n] }),
    /Unknown provider/
  );
  assert.equal(conversation.provider, 'deepseek', 'a failed switch leaves the provider intact');
});

test('/clear wipes memory but keeps the session alive', async () => {
  const dir = await temp();
  const seen = [];
  await drive(['one', '/clear', 'two', '/exit'], {
    sessionDir: dir,
    ask: async request => { seen.push(request.messages); return { provider: 'alfred', model: 'alfred-coder-7b', text: 'r', usage: null }; }
  });
  assert.equal(seen.length, 2);
  assert.ok(!seen[1].some(m => m.content === 'one'), 'cleared history must not be resent');
  await fs.rm(dir, { recursive: true, force: true });
});
