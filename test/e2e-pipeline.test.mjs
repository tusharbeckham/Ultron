// End-to-end: a real pipeline run through the real provider adapter against a stub
// OpenAI-compatible server, with a real preToolUse hook in the loop.
// Proves the pieces compose — no mocking of the runner or the provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipeline } from '../src/subagents.mjs';
import { loadHookConfig, guardToolUse } from '../src/hooks.mjs';
import { providers } from '../src/providers.mjs';

async function stubServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const reply = handler(payload, req);
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

const reply = text => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

const agents = {
  a: { name: 'a', provider: 'local', model: 'local' },
  b: { name: 'b', provider: 'local', model: 'local' }
};
const pipeline = {
  name: 'e2e',
  stages: [
    { name: 'first', agent: 'a', prompt: 'objective: {task}' },
    { name: 'second', agent: 'b', depends_on: ['first'], prompt: 'refine: {first}' }
  ]
};

async function invokeViaProvider({ agent, prompt }) {
  const result = await providers[agent.provider].askDetailed(prompt, { model: agent.model });
  return { text: result.text, usage: result.usage, model: agent.model };
}

test('a pipeline runs end-to-end through the real local provider', async t => {
  const seen = [];
  const stub = await stubServer(payload => {
    seen.push(payload.messages.at(-1).content);
    return reply(`handled(${payload.messages.at(-1).content})`);
  });
  t.after(() => stub.close());
  process.env.ULTRON_LOCAL_BASE_URL = stub.baseUrl;
  t.after(() => { delete process.env.ULTRON_LOCAL_BASE_URL; });

  const result = await runPipeline({ pipeline, agents, task: 'ship it', invoke: invokeViaProvider });

  assert.equal(result.ok, true, result.reason);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], 'objective: ship it', 'the {task} placeholder reached the provider');
  assert.match(seen[1], /^refine: handled\(objective: ship it\)$/, 'stage output fed the next stage');
  assert.equal(result.stages.second.text, 'handled(refine: handled(objective: ship it))');
  assert.equal(result.estimatedCostUsd, 0, 'local is free');
});

test('a hook can veto a stage before any provider call happens', async t => {
  let providerCalls = 0;
  const stub = await stubServer(() => { providerCalls++; return reply('should never be reached'); });
  t.after(() => stub.close());
  process.env.ULTRON_LOCAL_BASE_URL = stub.baseUrl;
  t.after(() => { delete process.env.ULTRON_LOCAL_BASE_URL; });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.ultron'), { recursive: true });
  // A hook that always exits 1 -> must veto every stage.
  await fs.writeFile(path.join(dir, 'deny.mjs'), 'process.stdin.resume();process.stdin.on("end",()=>{console.error("denied by test policy");process.exit(1)});');
  await fs.writeFile(path.join(dir, '.ultron', 'hooks.json'), JSON.stringify({
    preToolUse: [{ matcher: 'subagent', command: process.execPath, args: [path.join(dir, 'deny.mjs')], timeoutMs: 10000, canDeny: true }]
  }));
  const hookConfig = await loadHookConfig(dir);
  assert.equal(hookConfig.hooks.preToolUse.length, 1, 'hook config loaded');

  const result = await runPipeline({
    pipeline, agents, task: 'ship it',
    invoke: async ({ agent, prompt, stage }) => {
      await guardToolUse(hookConfig, 'subagent', { agent: agent.name, stage: stage.name }, { cwd: dir });
      return invokeViaProvider({ agent, prompt });
    }
  });

  assert.equal(result.ok, false);
  assert.equal(providerCalls, 0, 'the veto must happen BEFORE the provider is called');
  assert.match(result.stages.first.reason, /denied by hook/);
  assert.match(result.stages.first.reason, /denied by test policy/);
  assert.equal(result.stages.second.skipped, true, 'the dependent stage is skipped');
});

test('a hook that allows lets the pipeline through', async t => {
  const stub = await stubServer(() => reply('ok'));
  t.after(() => stub.close());
  process.env.ULTRON_LOCAL_BASE_URL = stub.baseUrl;
  t.after(() => { delete process.env.ULTRON_LOCAL_BASE_URL; });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultron-e2e-allow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.ultron'), { recursive: true });
  await fs.writeFile(path.join(dir, 'allow.mjs'), 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));');
  await fs.writeFile(path.join(dir, '.ultron', 'hooks.json'), JSON.stringify({
    preToolUse: [{ matcher: 'subagent', command: process.execPath, args: [path.join(dir, 'allow.mjs')], timeoutMs: 10000, canDeny: true }]
  }));
  const hookConfig = await loadHookConfig(dir);

  const result = await runPipeline({
    pipeline, agents, task: 'go',
    invoke: async ({ agent, prompt, stage }) => {
      await guardToolUse(hookConfig, 'subagent', { agent: agent.name, stage: stage.name }, { cwd: dir });
      return invokeViaProvider({ agent, prompt });
    }
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.stages.second.text, 'ok');
});

test('the shipped feature and research pipelines are valid against the shipped agents', async () => {
  const { loadAgents, loadPipeline, validatePipeline, computeWaves } = await import('../src/subagents.mjs');
  const root = path.resolve(import.meta.dirname, '..');
  const shipped = await loadAgents(root);
  assert.ok(Object.keys(shipped).length >= 4, 'example agents are shipped');

  for (const name of ['feature', 'research']) {
    const pipeline = await loadPipeline(root, name);
    const check = validatePipeline(pipeline, shipped);
    assert.deepEqual(check.errors, [], `${name}: ${check.errors.join('; ')}`);
    assert.ok(computeWaves(pipeline).length >= 2, `${name} has multiple waves`);
  }

  // The research pipeline must genuinely fan out in parallel.
  const research = await loadPipeline(root, 'research');
  assert.equal(computeWaves(research)[0].length, 3, 'three parallel research tracks');

  // Every shipped agent must reference a real provider.
  for (const agent of Object.values(shipped)) {
    assert.ok(providers[agent.provider], `agent ${agent.name} references unknown provider ${agent.provider}`);
  }
});
