import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRegistry, getModel, listModels, estimateCostUsd, recommendTier, routingLadder } from '../src/models.mjs';

test('every registry entry has complete numeric metadata', () => {
  assert.ok(modelRegistry.length >= 5);
  for (const m of modelRegistry) {
    assert.equal(typeof m.id, 'string', `${m.id} id`);
    assert.equal(typeof m.provider, 'string', `${m.id} provider`);
    for (const field of ['contextWindow', 'maxOutput', 'inputUsdPerMillion', 'outputUsdPerMillion', 'tier']) {
      assert.equal(typeof m[field], 'number', `${m.id}.${field} must be a number`);
      assert.ok(Number.isFinite(m[field]), `${m.id}.${field} must be finite`);
    }
    assert.ok(m.tier >= 0 && m.tier <= 4, `${m.id} tier in range`);
  }
});

test('the verified model ids are present with the right providers', () => {
  assert.equal(getModel('alfred-coder-7b').provider, 'alfred');
  assert.equal(getModel('kimi-k3').provider, 'kimi');
  assert.equal(getModel('deepseek-v4-flash').provider, 'deepseek');
  assert.equal(getModel('deepseek-v4-pro').provider, 'deepseek');
  assert.equal(getModel('glm-5.2').provider, 'zai');
  assert.equal(getModel('local').provider, 'local');
});

test('getModel rejects unknown ids', () => {
  assert.throws(() => getModel('gpt-nonexistent-9'), /Unknown model/);
});

test('listModels filters by provider', () => {
  const ds = listModels({ provider: 'deepseek' }).map(m => m.id).sort();
  assert.deepEqual(ds, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(listModels().length, modelRegistry.length);
});

test('estimateCostUsd is exact arithmetic', () => {
  // flash: 0.14 in / 0.28 out per 1M
  assert.equal(estimateCostUsd('deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 0 }), 0.14);
  assert.equal(estimateCostUsd('deepseek-v4-flash', { inputTokens: 0, outputTokens: 1_000_000 }), 0.28);
  // kimi: 3.00 in / 15.00 out
  assert.equal(estimateCostUsd('kimi-k3', { inputTokens: 500_000, outputTokens: 100_000 }), 1.5 + 1.5);
  // local is free
  assert.equal(estimateCostUsd('local', { inputTokens: 9_999_999, outputTokens: 9_999_999 }), 0);
  // defaults to zero tokens
  assert.equal(estimateCostUsd('glm-5.2'), 0);
});

test('recommendTier routes to the cheapest capable tier and is deterministic', () => {
  const cases = [
    ['fix a typo in a comment', 0, 'alfred-coder-7b'],
    ['write some boilerplate and a regex', 0, 'alfred-coder-7b'],
    ['summarize this changelog', 1, 'deepseek-v4-flash'],
    ['implement a unit test for the parser', 1, 'deepseek-v4-flash'],
    ['refactor this multi-file module and optimize the algorithm', 2, 'glm-5.2'],
    ['do a security threat model of the auth flow', 3, 'deepseek-v4-pro'],
    ['debug the root cause of this concurrency bug', 3, 'deepseek-v4-pro'],
    ['run a long-horizon agentic task over the whole repository', 4, 'kimi-k3']
  ];
  for (const [task, tier, modelId] of cases) {
    const got = recommendTier(task);
    assert.equal(got.tier, tier, `"${task}" -> tier ${got.tier}, expected ${tier}`);
    assert.equal(got.modelId, modelId, `"${task}" -> ${got.modelId}`);
    assert.equal(typeof got.reason, 'string');
    assert.deepEqual(recommendTier(task), got, 'must be deterministic');
  }
});

test('recommendTier defaults to the cheapest API tier with no signal', () => {
  const got = recommendTier('xyzzy');
  assert.equal(got.tier, 1);
  assert.equal(got.modelId, 'deepseek-v4-flash');
  assert.equal(recommendTier('').tier, 1);
});

test('routingLadder is sorted cheapest-tier-first and starts at free', () => {
  const tiers = routingLadder.map(m => m.tier);
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
  assert.equal(routingLadder[0].tier, 0);
  assert.equal(routingLadder[0].inputUsdPerMillion, 0);
});
