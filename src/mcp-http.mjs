// Remote MCP over Streamable HTTP (the stdio client stays in mcp.mjs).
// Origin-allowlisted, bearer-authenticated, and treats all tool output as untrusted data.
import { loadToken } from './tokens.mjs';

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['https://mcp.notion.com']);
export const MCP_PROTOCOL_VERSION = '2025-03-26';

export function allowedOrigins() {
  const extra = (process.env.ULTRON_MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

/** Only https:// origins on the allowlist may be contacted. Fails closed. */
export function assertAllowedUrl(url, origins = allowedOrigins()) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid MCP URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`Remote MCP requires https://, got ${parsed.protocol}//`);
  if (!origins.includes(parsed.origin)) throw new Error(`MCP origin not allowlisted: ${parsed.origin}. Allowed: ${origins.join(', ')}`);
  return parsed.origin;
}

/** Parse a Streamable-HTTP response body: either a JSON object or an SSE stream of them. */
export function parseStreamableBody(contentType, text) {
  if (String(contentType || '').includes('text/event-stream')) {
    const messages = [];
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { messages.push(JSON.parse(data)); } catch { /* ignore non-JSON keepalives */ }
    }
    if (!messages.length) throw new Error('MCP SSE response contained no JSON message');
    return messages[messages.length - 1];
  }
  if (!text.trim()) throw new Error('Empty MCP response body');
  try { return JSON.parse(text); } catch { throw new Error(`Invalid MCP JSON response: ${text.slice(0, 200)}`); }
}

export class McpHttpClient {
  constructor(url, { token = null, tokenKey = 'notion', timeoutMs = 30000, fetchImpl = fetch, origins } = {}) {
    assertAllowedUrl(url, origins || allowedOrigins());
    this.url = url;
    this.explicitToken = token;
    this.tokenKey = tokenKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  bearer() {
    if (this.explicitToken) return this.explicitToken;
    const stored = loadToken(this.tokenKey);
    if (!stored?.accessToken) throw new Error(`No token for '${this.tokenKey}'. Run: ultron notion login`);
    return stored.accessToken;
  }

  async send(method, params = {}, { notification = false } = {}) {
    const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.bearer()}`,
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`MCP request timed out: ${method}`)), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } finally { clearTimeout(timer); }

    const session = res.headers?.get?.('mcp-session-id');
    if (session) this.sessionId = session;
    if (notification) return null;

    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} on ${method}: ${text.slice(0, 200)}`);
    const message = parseStreamableBody(res.headers?.get?.('content-type'), text);
    if (message.error) throw new Error(`MCP error on ${method}: ${message.error.message || JSON.stringify(message.error)}`);
    return message.result;
  }

  async start() {
    if (this.initialized) return this;
    await this.send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ultron-cli', version: '0.5.0' }
    });
    await this.send('notifications/initialized', {}, { notification: true });
    this.initialized = true;
    return this;
  }

  listTools() { return this.send('tools/list'); }
  callTool(name, args = {}) { return this.send('tools/call', { name, arguments: args }); }
  close() { this.sessionId = null; this.initialized = false; }
}
