import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, getProvider, localBase, probeLocal } from '../src/providers.mjs';

function headers(values = {}) { return { get: name => values[name.toLowerCase()] ?? values[name] ?? null }; }
function response(body, { ok = true, status = 200, headerValues = {} } = {}) { return { ok, status, statusText: '', headers: headers(headerValues), text: async () => JSON.stringify(body) }; }
const chat = text => response({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 2, completion_tokens: 1 } });

const NEW = ['deepseek', 'zai', 'local'];

test('new providers are registered', () => { for (const name of NEW) assert.ok(providers[name], `${name} missing`); });

test('existing providers are untouched', () => { for (const name of ['openai', 'anthropic', 'kimi', 'custom', 'kiro', 'claude-code', 'openclaw']) assert.ok(providers[name], `${name} regressed`); });

test('new providers honour the provider contract', () => {
  for (const name of NEW) {
    const p = getProvider(name);
    assert.equal(typeof p.description, 'string', `${name} description`);
    assert.equal(typeof p.configured, 'function', `${name} configured`);
    assert.equal(typeof p.ask, 'function', `${name} ask`);
    assert.equal(typeof p.askDetailed, 'function', `${name} askDetailed`);
    assert.equal(typeof p.listModels, 'function', `${name} listModels`);
    assert.equal(p.capabilities.streaming, true, `${name} streaming`);
    assert.equal(p.capabilities.conversation, true, `${name} conversation`);
  }
});

test('configured() reacts to the documented env vars', () => {
  delete process.env.DEEPSEEK_API_KEY; delete process.env.ZAI_API_KEY;
  assert.equal(providers.deepseek.configured(), false);
  assert.equal(providers.zai.configured(), false);
  process.env.DEEPSEEK_API_KEY = 'k'; process.env.ZAI_API_KEY = 'k';
  assert.equal(providers.deepseek.configured(), true);
  assert.equal(providers.zai.configured(), true);
  delete process.env.DEEPSEEK_API_KEY; delete process.env.ZAI_API_KEY;
  // local needs no key
  assert.equal(providers.local.configured(), true);
});

test('deepseek posts to the documented base URL with a bearer key and the default model', async () => {
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  delete process.env.DEEPSEEK_BASE_URL; delete process.env.DEEPSEEK_MODEL;
  let url, options;
  const result = await providers.deepseek.askDetailed('hi', { fetchImpl: async (u, o) => { url = u; options = o; return chat('pong'); } });
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(options.headers.Authorization, 'Bearer ds-test');
  assert.equal(JSON.parse(options.body).model, 'deepseek-v4-flash');
  assert.equal(result.text, 'pong');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.usage.inputTokens, 2);
  delete process.env.DEEPSEEK_API_KEY;
});

test('deepseek honours an explicit model override (pro)', async () => {
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  let body;
  await providers.deepseek.askDetailed('hi', { model: 'deepseek-v4-pro', fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return chat('ok'); } });
  assert.equal(body.model, 'deepseek-v4-pro');
  delete process.env.DEEPSEEK_API_KEY;
});

test('zai posts to the z.ai paas base URL with glm-5.2 by default', async () => {
  process.env.ZAI_API_KEY = 'z-test';
  delete process.env.ZAI_BASE_URL; delete process.env.ZAI_MODEL;
  let url, body;
  await providers.zai.askDetailed('hi', { fetchImpl: async (u, o) => { url = u; body = JSON.parse(o.body); return chat('ok'); } });
  assert.equal(url, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(body.model, 'glm-5.2');
  delete process.env.ZAI_API_KEY;
});

test('local defaults to the LM Studio endpoint and needs no real key', async () => {
  delete process.env.ULTRON_LOCAL_BASE_URL; delete process.env.ULTRON_LOCAL_API_KEY; delete process.env.ULTRON_LOCAL_MODEL;
  assert.equal(localBase(), 'http://localhost:1234/v1');
  let url, options;
  await providers.local.askDetailed('hi', { fetchImpl: async (u, o) => { url = u; options = o; return chat('ok'); } });
  assert.equal(url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(options.headers.Authorization, 'Bearer local');
});

test('local base URL is configurable for ollama / llama.cpp / vLLM', () => {
  process.env.ULTRON_LOCAL_BASE_URL = 'http://localhost:11434/v1/';
  assert.equal(localBase(), 'http://localhost:11434/v1');
  process.env.ULTRON_LOCAL_BASE_URL = 'http://localhost:8000/v1';
  assert.equal(localBase(), 'http://localhost:8000/v1');
  delete process.env.ULTRON_LOCAL_BASE_URL;
});

test('probeLocal reports liveness without throwing', async () => {
  assert.equal(await probeLocal({ fetchImpl: async () => ({ ok: true }) }), true);
  assert.equal(await probeLocal({ fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await probeLocal({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});

test('new providers discover models from /models', async () => {
  process.env.DEEPSEEK_API_KEY = 'ds';
  let url;
  const models = await providers.deepseek.listModels({ fetchImpl: async u => { url = u; return response({ data: [{ id: 'deepseek-v4-flash' }] }); } });
  assert.match(url, /\/models$/);
  assert.equal(models[0].id, 'deepseek-v4-flash');
  delete process.env.DEEPSEEK_API_KEY;
});
