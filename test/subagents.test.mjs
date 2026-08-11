import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePipeline, computeWaves, toMermaid, renderPrompt, runPipeline, MAX_DEPTH
} from '../src/subagents.mjs';

const agents = {
  planner: { name: 'planner', provider: 'local', model: 'local' },
  coder: { name: 'coder', provider: 'deepseek', model: 'deepseek-v4-flash' },
  tester: { name: 'tester', provider: 'deepseek', model: 'deepseek-v4-flash' },
  reviewer: { name: 'reviewer', provider: 'zai', model: 'glm-5.2' }
};

const feature = {
  name: 'feature',
  stages: [
    { name: 'plan', agent: 'planner', prompt: '{task}' },
    { name: 'code', agent: 'coder', depends_on: ['plan'] },
    { name: 'docs', agent: 'planner', depends_on: ['plan'] },
    { name: 'review', agent: 'reviewer', depends_on: ['code', 'docs'] }
  ]
};

const echo = text => async () => ({ text });

test('a well-formed pipeline validates', () => {
  assert.deepEqual(validatePipeline(feature, agents), { valid: true, errors: [] });
});

test('validation rejects duplicate stage names', () => {
  const bad = { stages: [{ name: 'a', agent: 'coder' }, { name: 'a', agent: 'coder' }] };
  const { valid, errors } = validatePipeline(bad, agents);
  assert.equal(valid, false);
  assert.ok(errors.some(e => /duplicate stage name: a/.test(e)));
});

test('validation rejects an unresolvable dependency', () => {
  const bad = { stages: [{ name: 'a', agent: 'coder', depends_on: ['ghost'] }] };
  assert.ok(validatePipeline(bad, agents).errors.some(e => /depends_on unknown stage "ghost"/.test(e)));
});

test('validation rejects an unknown agent', () => {
  const bad = { stages: [{ name: 'a', agent: 'nobody' }] };
  assert.ok(validatePipeline(bad, agents).errors.some(e => /unknown agent "nobody"/.test(e)));
});

test('validation detects a dependency cycle', () => {
  const cyclic = { stages: [
    { name: 'a', agent: 'coder', depends_on: ['c'] },
    { name: 'b', agent: 'coder', depends_on: ['a'] },
    { name: 'c', agent: 'coder', depends_on: ['b'] }
  ] };
  const { valid, errors } = validatePipeline(cyclic, agents);
  assert.equal(valid, false);
  assert.ok(errors.some(e => /cycle detected/.test(e)), errors.join('; '));
  assert.throws(() => computeWaves(cyclic), /Invalid pipeline/);
});

test('validation rejects a self-dependency', () => {
  const bad = { stages: [{ name: 'a', agent: 'coder', depends_on: ['a'] }] };
  assert.equal(validatePipeline(bad, agents).valid, false);
});

test('validation enforces bounded loops', () => {
  const unbounded = { stages: [
    { name: 'code', agent: 'coder' },
    { name: 'test', agent: 'tester', depends_on: ['code'], loop_to: { target: 'code', trigger: 'FAIL', max_iterations: 999 } }
  ] };
  assert.ok(validatePipeline(unbounded, agents).errors.some(e => /max_iterations must be an integer 1-10/.test(e)));

  const noTarget = { stages: [{ name: 'test', agent: 'tester', loop_to: { trigger: 'FAIL', max_iterations: 2 } }] };
  assert.ok(validatePipeline(noTarget, agents).errors.some(e => /loop_to needs a target/.test(e)));

  const ghostTarget = { stages: [{ name: 'test', agent: 'tester', loop_to: { target: 'nope', trigger: 'F', max_iterations: 2 } }] };
  assert.ok(validatePipeline(ghostTarget, agents).errors.some(e => /does not exist/.test(e)));
});

test('waves put independent stages in parallel', () => {
  assert.deepEqual(computeWaves(feature), [['plan'], ['code', 'docs'], ['review']]);
});

test('mermaid output includes edges and the bounded loop', () => {
  const graph = toMermaid({ stages: [
    { name: 'code', agent: 'coder' },
    { name: 'test', agent: 'tester', depends_on: ['code'], loop_to: { target: 'code', trigger: 'TESTS_FAIL', max_iterations: 2 } }
  ] });
  assert.match(graph, /graph TD/);
  assert.match(graph, /code --> test/);
  assert.match(graph, /test -\. "TESTS_FAIL \(max 2\)" \.-> code/);
});

test('renderPrompt substitutes context and leaves unknown placeholders intact', () => {
  assert.equal(renderPrompt('do {task} using {plan}', { task: 'X', plan: 'P' }), 'do X using P');
  assert.equal(renderPrompt('{task} then {missing}', { task: 'X' }), 'X then {missing}');
});

test('a happy-path pipeline runs every stage and fans in', async () => {
  const seen = [];
  const result = await runPipeline({
    pipeline: feature, agents, task: 'build it',
    invoke: async ({ stage, prompt }) => { seen.push(stage.name); return { text: `${stage.name}:${prompt}` }; }
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.partial, false);
  assert.equal(seen.length, 4);
  assert.equal(seen[0], 'plan', 'plan must run first');
  assert.equal(seen[3], 'review', 'review must fan in last');
  assert.equal(result.stages.plan.text, 'plan:build it', 'the {task} placeholder resolved');
  assert.equal(result.stageRuns, 4);
});

test('a downstream stage is skipped when its dependency fails, but independent branches still run', async () => {
  const ran = [];
  const result = await runPipeline({
    pipeline: feature, agents, task: 't',
    invoke: async ({ stage }) => {
      ran.push(stage.name);
      if (stage.name === 'code') throw new Error('compile error');
      return { text: 'ok' };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.stages.code.ok, false);
  assert.equal(result.stages.docs.ok, true, 'the independent branch still ran');
  assert.equal(result.stages.review.skipped, true);
  assert.match(result.stages.review.reason, /blocked by code/);
  assert.ok(!ran.includes('review'), 'a blocked stage must never be invoked');
});

test('a stage that hangs is timed out rather than hanging the run', async () => {
  const pipeline = { stages: [{ name: 'slow', agent: 'coder', timeout: 0.05 }] };
  const result = await runPipeline({
    pipeline, agents, task: 't',
    invoke: () => new Promise(resolve => { const t = setTimeout(() => resolve({ text: 'too late' }), 5000); t.unref?.(); })
  });
  assert.equal(result.ok, false);
  assert.match(result.stages.slow.reason, /timed out after 0\.05s/);
});

test('a bounded loop retries the target then gives up without looping forever', async () => {
  const pipeline = { stages: [
    { name: 'code', agent: 'coder' },
    { name: 'test', agent: 'tester', depends_on: ['code'], loop_to: { target: 'code', trigger: 'TESTS_FAIL', max_iterations: 2, backoff: { baseMs: 1, jitter: false } } }
  ] };
  const calls = { code: 0, test: 0 };
  const result = await runPipeline({
    pipeline, agents, task: 't',
    invoke: async ({ stage }) => { calls[stage.name]++; return { text: stage.name === 'test' ? 'TESTS_FAIL always' : 'patched' }; }
  });
  assert.equal(calls.code, 3, 'initial run + 2 bounded retries');
  assert.equal(calls.test, 3);
  assert.equal(result.ok, false);
  assert.equal(result.stages.test.loopExhausted, true);
  assert.match(result.reason, /exhausted after 2 iteration/);
});

test('a loop stops early once the trigger clears', async () => {
  const pipeline = { stages: [
    { name: 'code', agent: 'coder' },
    { name: 'test', agent: 'tester', depends_on: ['code'], loop_to: { target: 'code', trigger: 'TESTS_FAIL', max_iterations: 5, backoff: { baseMs: 1, jitter: false } } }
  ] };
  let attempt = 0;
  const result = await runPipeline({
    pipeline, agents, task: 't',
    invoke: async ({ stage }) => stage.name === 'test' ? { text: ++attempt === 1 ? 'TESTS_FAIL' : 'all green' } : { text: 'code' }
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(attempt, 2, 'looped exactly once');
});

test('the stage-run budget aborts the run instead of overspending', async () => {
  const result = await runPipeline({
    pipeline: feature, agents, task: 't', budget: { maxStageRuns: 2 },
    invoke: echo('ok')
  });
  assert.equal(result.ok, false);
  assert.equal(result.stageRuns, 2, 'never exceeds the cap');
  assert.match(result.reason, /stage-run budget of 2 exhausted/);
});

test('the cost budget aborts the run using registry prices', async () => {
  const pipeline = { stages: [
    { name: 'a', agent: 'coder' },
    { name: 'b', agent: 'coder', depends_on: ['a'] },
    { name: 'c', agent: 'coder', depends_on: ['b'] }
  ] };
  const result = await runPipeline({
    pipeline, agents, task: 't', budget: { maxUsdEstimate: 0.2 },
    // 1M input tokens on flash = $0.14 per stage, so stage 3 must be refused.
    invoke: async () => ({ text: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /cost budget of \$0\.2 reached/);
  assert.equal(result.stageRuns, 2);
  assert.ok(result.estimatedCostUsd >= 0.28);
});

test('an invalid pipeline is refused without invoking anything', async () => {
  let called = false;
  const result = await runPipeline({
    pipeline: { stages: [{ name: 'a', agent: 'coder', depends_on: ['ghost'] }] }, agents, task: 't',
    invoke: async () => { called = true; return { text: 'x' }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, false);
  assert.match(result.reason, /invalid pipeline/);
  assert.equal(called, false);
});

test('the depth cap stops runaway nesting', async () => {
  const result = await runPipeline({ pipeline: feature, agents, task: 't', depth: MAX_DEPTH, invoke: echo('x') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /depth cap of 3/);
});

test('runPipeline never throws — a broken invoke yields a partial result', async () => {
  const result = await runPipeline({
    pipeline: feature, agents, task: 't',
    invoke: () => { throw new Error('provider exploded'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.match(result.stages.plan.reason, /provider exploded/);
});

test('runPipeline requires an invoke function', async () => {
  await assert.rejects(() => runPipeline({ pipeline: feature, agents }), /requires an invoke/);
});
