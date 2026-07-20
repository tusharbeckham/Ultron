import { runCommand, commandExists } from './process.mjs';

function required(value, name) { if (!value) throw new Error(`${name} is required`); return value; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ProviderHttpError extends Error {
  constructor(status, message, { headers, body } = {}) {
    super(`HTTP ${status}: ${message}`); this.name = 'ProviderHttpError'; this.status = status; this.headers = headers; this.body = body;
  }
}

function retryDelay(headers, attempt, baseMs, maxMs) {
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter); if (Number.isFinite(seconds)) return Math.min(maxMs, seconds * 1000);
    const date = Date.parse(retryAfter); if (Number.isFinite(date)) return Math.min(maxMs, Math.max(0, date - Date.now()));
  }
  return Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

function rateLimitInfo(headers) {
  const names = ['retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset'];
  return Object.fromEntries(names.map(name => [name, headers?.get?.(name)]).filter(([, value]) => value != null));
}

function combineSignal(external, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)); }, timeoutMs);
  const onAbort = () => controller.abort(external.reason || new Error('Request cancelled'));
  if (external) { if (external.aborted) onAbort(); else external.addEventListener('abort', onAbort, { once: true }); }
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); external?.removeEventListener?.('abort', onAbort); }, timedOut: () => timedOut };
}

async function request(url, options, { fetchImpl = fetch, timeoutMs = Number(process.env.ULTRON_TIMEOUT_MS || 60000), maxRetries = Number(process.env.ULTRON_MAX_RETRIES || 2), retryBaseMs = Number(process.env.ULTRON_RETRY_BASE_MS || 500), retryMaxMs = Number(process.env.ULTRON_RETRY_MAX_MS || 10000), signal, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const combined = combineSignal(signal, timeoutMs);
    try {
      const res = await fetchImpl(url, { ...options, signal: combined.signal });
      if (res.ok) return res;
      const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
      const message = body?.error?.message || body?.message || text.slice(0, 300) || res.statusText;
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries) throw new ProviderHttpError(res.status, message, { headers: rateLimitInfo(res.headers), body });
      const delayMs = retryDelay(res.headers, attempt, retryBaseMs, retryMaxMs); onRetry({ attempt: attempt + 1, delayMs, status: res.status }); await sleep(delayMs);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      if (signal?.aborted) throw new Error('Request cancelled', { cause: error });
      if (combined.timedOut() && attempt >= maxRetries) throw new Error(`Request timed out after ${timeoutMs}ms`, { cause: error });
      if (attempt >= maxRetries) throw error;
      const delayMs = retryDelay(null, attempt, retryBaseMs, retryMaxMs); onRetry({ attempt: attempt + 1, delayMs, error: error.message }); await sleep(delayMs);
    } finally { combined.cleanup(); }
  }
}

async function jsonRequest(url, options, policy) {
  const res = await request(url, options, policy); const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { throw new Error(`Invalid JSON response: ${text.slice(0, 300)}`); }
  return { body, headers: res.headers };
}

async function readSse(res, onEvent) {
  if (!res.body?.getReader) throw new Error('Streaming response body is unavailable');
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || '';
    for (const frame of frames) {
      const event = frame.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') { let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; } await onEvent({ event, data: parsed }); }
    }
    if (done) break;
  }
}

function openAIText(body) {
  if (typeof body.output_text === 'string') return body.output_text;
  const pieces = []; for (const item of body.output || []) for (const part of item.content || []) if (part.text) pieces.push(part.text);
  return pieces.join('\n') || body.choices?.[0]?.message?.content || JSON.stringify(body, null, 2);
}
function normalizeUsage(usage = {}) { return { inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0, outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0, cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0, raw: usage }; }
function estimateCost(usage, prefix) {
  const input = Number(process.env[`${prefix}_INPUT_USD_PER_MILLION`] || 0), output = Number(process.env[`${prefix}_OUTPUT_USD_PER_MILLION`] || 0);
  return input || output ? ((usage.inputTokens * input + usage.outputTokens * output) / 1_000_000) : null;
}
function result(provider, model, text, usage, headers, prefix) { const normalized = normalizeUsage(usage); return { provider, model, text, usage: normalized, estimatedCostUsd: estimateCost(normalized, prefix), rateLimit: rateLimitInfo(headers) }; }
const bearer = key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const anthropicHeaders = key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' });

async function openAICompatibleAsk({ provider, prefix, base, key, endpoint = 'chat/completions', model, prompt, stream, onToken = () => {}, policy }) {
  const payload = { model, messages: [{ role: 'user', content: prompt }], stream: !!stream, ...(stream ? { stream_options: { include_usage: true } } : {}) };
  if (!stream) { const { body, headers } = await jsonRequest(`${base}/${endpoint}`, { method: 'POST', headers: bearer(key), body: JSON.stringify(payload) }, policy); return result(provider, model, openAIText(body), body.usage, headers, prefix); }
  const res = await request(`${base}/${endpoint}`, { method: 'POST', headers: bearer(key), body: JSON.stringify(payload) }, policy); let text = '', usage = {};
  await readSse(res, ({ data }) => { const delta = data?.choices?.[0]?.delta?.content || ''; if (delta) { text += delta; onToken(delta); } if (data?.usage) usage = data.usage; });
  return result(provider, model, text, usage, res.headers, prefix);
}

export const providers = {
  openai: {
    description: 'OpenAI Responses API', configured: () => !!process.env.OPENAI_API_KEY,
    capabilities: { streaming: true, cancellation: true, retries: true, models: true, usage: true },
    async askDetailed(prompt, opts = {}) {
      const key = required(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY'), base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model = opts.model || process.env.OPENAI_MODEL || 'gpt-5.6';
      if (!opts.stream) { const { body, headers } = await jsonRequest(`${base}/responses`, { method: 'POST', headers: bearer(key), body: JSON.stringify({ model, input: prompt }) }, opts); return result('openai', model, openAIText(body), body.usage, headers, 'OPENAI'); }
      const res = await request(`${base}/responses`, { method: 'POST', headers: bearer(key), body: JSON.stringify({ model, input: prompt, stream: true }) }, opts); let text = '', usage = {};
      await readSse(res, ({ event, data }) => { if (event === 'response.output_text.delta' || data?.type === 'response.output_text.delta') { const delta = data.delta || ''; text += delta; opts.onToken?.(delta); } if (event === 'response.completed' || data?.type === 'response.completed') usage = data.response?.usage || usage; });
      return result('openai', model, text, usage, res.headers, 'OPENAI');
    },
    async ask(prompt, opts) { return (await this.askDetailed(prompt, opts)).text; },
    async listModels(opts = {}) { const key = required(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY'), base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''); return (await jsonRequest(`${base}/models`, { headers: bearer(key) }, opts)).body.data || []; }
  },
  anthropic: {
    description: 'Anthropic Messages API', configured: () => !!process.env.ANTHROPIC_API_KEY,
    capabilities: { streaming: true, cancellation: true, retries: true, models: true, usage: true },
    async askDetailed(prompt, opts = {}) {
      const key = required(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'), base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''), model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
      const payload = { model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }], stream: !!opts.stream };
      if (!opts.stream) { const { body, headers } = await jsonRequest(`${base}/messages`, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(payload) }, opts); return result('anthropic', model, (body.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n'), body.usage, headers, 'ANTHROPIC'); }
      const res = await request(`${base}/messages`, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(payload) }, opts); let text = '', usage = {};
      await readSse(res, ({ event, data }) => { if (event === 'content_block_delta' && data?.delta?.type === 'text_delta') { text += data.delta.text; opts.onToken?.(data.delta.text); } if (event === 'message_start') usage = data.message?.usage || {}; if (event === 'message_delta') usage = { ...usage, ...data.usage }; });
      return result('anthropic', model, text, usage, res.headers, 'ANTHROPIC');
    },
    async ask(prompt, opts) { return (await this.askDetailed(prompt, opts)).text; },
    async listModels(opts = {}) { const key = required(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'), base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''); return (await jsonRequest(`${base}/models`, { headers: anthropicHeaders(key) }, opts)).body.data || []; }
  },
  kimi: {
    description: 'Kimi / Moonshot OpenAI-compatible API', configured: () => !!process.env.MOONSHOT_API_KEY,
    capabilities: { streaming: true, cancellation: true, retries: true, models: true, usage: true },
    async askDetailed(prompt, opts = {}) { return openAICompatibleAsk({ provider: 'kimi', prefix: 'KIMI', base: (process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, ''), key: required(process.env.MOONSHOT_API_KEY, 'MOONSHOT_API_KEY'), model: opts.model || process.env.KIMI_MODEL || 'kimi-k3', prompt, stream: opts.stream, onToken: opts.onToken, policy: opts }); },
    async ask(prompt, opts) { return (await this.askDetailed(prompt, opts)).text; },
    async listModels(opts = {}) { const base = (process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, ''); return (await jsonRequest(`${base}/models`, { headers: bearer(required(process.env.MOONSHOT_API_KEY, 'MOONSHOT_API_KEY')) }, opts)).body.data || []; }
  },
  custom: {
    description: 'Any OpenAI-compatible Chat Completions endpoint', configured: () => !!(process.env.ULTRON_CUSTOM_BASE_URL && process.env.ULTRON_CUSTOM_API_KEY),
    capabilities: { streaming: true, cancellation: true, retries: true, models: true, usage: true },
    async askDetailed(prompt, opts = {}) { return openAICompatibleAsk({ provider: 'custom', prefix: 'ULTRON_CUSTOM', base: required(process.env.ULTRON_CUSTOM_BASE_URL, 'ULTRON_CUSTOM_BASE_URL').replace(/\/$/, ''), key: required(process.env.ULTRON_CUSTOM_API_KEY, 'ULTRON_CUSTOM_API_KEY'), model: required(opts.model || process.env.ULTRON_CUSTOM_MODEL, 'ULTRON_CUSTOM_MODEL or --model'), prompt, stream: opts.stream, onToken: opts.onToken, policy: opts }); },
    async ask(prompt, opts) { return (await this.askDetailed(prompt, opts)).text; },
    async listModels(opts = {}) { const base = required(process.env.ULTRON_CUSTOM_BASE_URL, 'ULTRON_CUSTOM_BASE_URL').replace(/\/$/, ''); return (await jsonRequest(`${base}/models`, { headers: bearer(required(process.env.ULTRON_CUSTOM_API_KEY, 'ULTRON_CUSTOM_API_KEY')) }, opts)).body.data || []; }
  },
  kiro: { description: 'Kiro CLI headless adapter', configured: () => !!process.env.KIRO_API_KEY, capabilities: { streaming: false, cancellation: false, retries: false, models: false, usage: false }, async available() { return commandExists(process.env.KIRO_COMMAND || 'kiro-cli'); }, async ask(prompt, { trustAll = false } = {}) { required(process.env.KIRO_API_KEY, 'KIRO_API_KEY'); const args = ['chat', '--no-interactive']; if (trustAll) args.push('--trust-all-tools'); args.push(prompt); return (await runCommand(process.env.KIRO_COMMAND || 'kiro-cli', args)).stdout; } },
  'claude-code': { description: 'Claude Code one-shot adapter', configured: () => true, capabilities: { streaming: false, cancellation: false, retries: false, models: false, usage: false }, async available() { return commandExists(process.env.CLAUDE_CODE_COMMAND || 'claude'); }, async ask(prompt) { const out = (await runCommand(process.env.CLAUDE_CODE_COMMAND || 'claude', ['-p', prompt, '--output-format', 'json'])).stdout; try { const j = JSON.parse(out); return j.result || j.response || out; } catch { return out; } } },
  openclaw: { description: 'OpenClaw agent adapter', configured: () => true, capabilities: { streaming: false, cancellation: false, retries: false, models: false, usage: false }, async available() { return commandExists(process.env.OPENCLAW_COMMAND || 'openclaw'); }, async ask(prompt, { model } = {}) { const args = ['agent', '--agent', process.env.OPENCLAW_AGENT || 'main', '--message', prompt, '--json']; if (model) args.push('--model', model); const out = (await runCommand(process.env.OPENCLAW_COMMAND || 'openclaw', args)).stdout; try { const j = JSON.parse(out); return j.payloads?.map(x => x.text).filter(Boolean).join('\n') || j.result || out; } catch { return out; } } }
};
export function getProvider(name) { const provider = providers[name]; if (!provider) throw new Error(`Unknown provider: ${name}`); return provider; }
