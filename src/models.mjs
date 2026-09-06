// Model registry — single source of truth for model ids, limits, prices, and routing tier.
// Verified against official provider docs 2026-08-11. Never invent a model id here.

const entry = (id, provider, contextWindow, maxOutput, inputUsdPerMillion, outputUsdPerMillion, tier, notes) =>
  ({ id, provider, contextWindow, maxOutput, inputUsdPerMillion, outputUsdPerMillion, tier, notes });

export const modelRegistry = Object.freeze([
  entry('alfred-coder-7b', 'alfred', 32768, 4096, 0, 0, 0, 'Alfred-Coder: the Owner\'s fine-tuned Qwen2.5-Coder-7B via LM Studio. Free, offline, default.'),
  entry('local', 'local', 32768, 4096, 0, 0, 0, 'Whatever is loaded in LM Studio/Ollama/llama.cpp/vLLM. Free.'),
  entry('deepseek-v4-flash', 'deepseek', 1000000, 384000, 0.14, 0.28, 1, '284B total / 13B active. Cheapest capable API tier.'),
  entry('glm-5.2', 'zai', 1000000, 128000, 1.40, 4.40, 2, '753B MoE. Supports thinking mode.'),
  entry('deepseek-v4-pro', 'deepseek', 1000000, 384000, 0.435, 0.87, 3, '1.6T total / 49B active. Hard engineering, cheap for its class.'),
  entry('kimi-k3', 'kimi', 1048576, 128000, 3.00, 15.00, 4, '2.8T MoE. Agentic long-horizon work. Cache-hit input ~$0.30.'),
  entry('gpt-5.6', 'openai', 400000, 128000, 0, 0, 3, 'Prices not pinned; set OPENAI_*_USD_PER_MILLION to enable estimates.'),
  entry('claude-opus-4-8', 'anthropic', 200000, 64000, 0, 0, 4, 'Prices not pinned; set ANTHROPIC_*_USD_PER_MILLION to enable estimates.'),
  entry('glm-5.3', 'bai', 1000000, 128000, 0, 0, 2, 'Zhipu GLM-5.3 via B.AI. Free.'),
  entry('qwen-3.8-flash', 'bai', 1048576, 128000, 0, 0, 1, 'Alibaba Qwen 3.8 Flash via B.AI. Free.'),
  entry('mimo-v2.5', 'bai', 131072, 65536, 0, 0, 1, 'Xiaomi MiMo V2.5 via B.AI. Free. Strong at code.'),
  entry('hy3', 'bai', 262144, 65536, 0, 0, 2, 'Tencent Hunyuan 3 via B.AI. Free.')
].map(Object.freeze));

const byId = new Map(modelRegistry.map(m => [m.id, m]));

export function getModel(id) {
  const model = byId.get(id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

export function listModels({ provider } = {}) {
  return provider ? modelRegistry.filter(m => m.provider === provider) : [...modelRegistry];
}

export function estimateCostUsd(id, { inputTokens = 0, outputTokens = 0 } = {}) {
  const m = getModel(id);
  return (inputTokens * m.inputUsdPerMillion + outputTokens * m.outputUsdPerMillion) / 1_000_000;
}

// Deterministic keyword heuristics. Cheapest capable tier wins; escalate only on evidence.
const TIER_RULES = Object.freeze([
  { tier: 4, modelId: 'kimi-k3', reason: 'long-horizon agentic or whole-repository reasoning', patterns: [/\bagentic\b/, /\bwhole (repo|repository|codebase)\b/, /\bmulti[- ]day\b/, /\blong[- ]horizon\b/, /\b1m context\b/] },
  { tier: 3, modelId: 'deepseek-v4-pro', reason: 'hard engineering, architecture, or security-sensitive reasoning', patterns: [/\barchitect(ure)?\b/, /\bsecurity\b/, /\bthreat model\b/, /\bdistributed\b/, /\bconcurren(cy|t)\b/, /\bdebug\b/, /\broot cause\b/, /\bcryptograph/, /\bprove?\b/, /\bproof\b/] },
  { tier: 2, modelId: 'glm-5.2', reason: 'reasoning-heavy implementation that benefits from thinking mode', patterns: [/\brefactor\b/, /\bmulti[- ]file\b/, /\bdesign\b/, /\balgorithm\b/, /\boptimi[sz]e\b/, /\bmigrat(e|ion)\b/, /\breason/] },
  { tier: 1, modelId: 'deepseek-v4-flash', reason: 'bulk work: summarization, extraction, ordinary coding', patterns: [/\bsummari[sz]e\b/, /\bextract\b/, /\btranslate\b/, /\bimplement\b/, /\bwrite tests?\b/, /\bunit test\b/, /\bdocument\b/, /\bexplain\b/] },
  { tier: 0, modelId: 'alfred-coder-7b', reason: 'trivial or mechanical: the free local Alfred-Coder is sufficient', patterns: [/\bboilerplate\b/, /\bregex\b/, /\brename\b/, /\bformat\b/, /\btypo\b/, /\bcomment\b/, /\bsnippet\b/, /\bone[- ]liner\b/, /\bdraft\b/, /\bstub\b/] }
]);

export function recommendTier(taskDescription = '') {
  const text = String(taskDescription).toLowerCase();
  for (const rule of TIER_RULES) {
    if (rule.patterns.some(p => p.test(text))) {
      return { tier: rule.tier, modelId: rule.modelId, reason: rule.reason };
    }
  }
  return { tier: 1, modelId: 'deepseek-v4-flash', reason: 'no strong signal; default to the cheapest capable API tier' };
}

export const routingLadder = Object.freeze(
  [...modelRegistry].filter(m => m.tier != null).sort((a, b) => a.tier - b.tier)
    .map(m => Object.freeze({ tier: m.tier, id: m.id, provider: m.provider, inputUsdPerMillion: m.inputUsdPerMillion }))
);
