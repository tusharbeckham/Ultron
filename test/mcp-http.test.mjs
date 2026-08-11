import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpClient, assertAllowedUrl, parseStreamableBody, allowedOrigins, DEFAULT_ALLOWED_ORIGINS, MCP_PROTOCOL_VERSION } from '../src/mcp-http.mjs';

const headers = values => ({ get: name => values[name.toLowerCase()] ?? null });
const jsonRes = (body, extra = {}) => ({ ok: true, status: 200, headers: headers({ 'content-type': 'application/json', ...extra }), text: async () => JSON.stringify(body) });

test('notion is allowlisted by default', () => {
  assert.deepEqual(DEFAULT_ALLOWED_ORIGINS, ['https://mcp.notion.com']);
  assert.equal(assertAllowedUrl('https://mcp.notion.com/mcp'), 'https://mcp.notion.com');
});

test('non-https and non-allowlisted origins are refused', () => {
  assert.throws(() => assertAllowedUrl('http://mcp.notion.com/mcp'), /requires https/);
  assert.throws(() => assertAllowedUrl('https://evil.example.com/mcp'), /not allowlisted/);
  assert.throws(() => assertAllowedUrl('file:///etc/passwd'), /requires https/);
  assert.throws(() => assertAllowedUrl('not a url'), /Invalid MCP URL/);
});

test('the allowlist is extensible only through an explicit env var', () => {
  assert.equal(allowedOrigins().includes('https://mcp.example.dev'), false);
  process.env.ULTRON_MCP_ALLOWED_ORIGINS = 'https://mcp.example.dev';
  assert.equal(allowedOrigins().includes('https://mcp.example.dev'), true);
  assert.equal(assertAllowedUrl('https://mcp.example.dev/mcp'), 'https://mcp.example.dev');
  delete process.env.ULTRON_MCP_ALLOWED_ORIGINS;
});

test('a constructor with a bad origin fails immediately', () => {
  assert.throws(() => new McpHttpClient('https://evil.test/mcp', { token: 't' }), /not allowlisted/);
});

test('parseStreamableBody handles plain JSON', () => {
  assert.deepEqual(parseStreamableBody('application/json', '{"result":{"ok":true}}'), { result: { ok: true } });
});

test('parseStreamableBody handles an SSE stream and takes the final message', () => {
  const sse = 'event: message\ndata: {"id":1,"result":{"step":"first"}}\n\nevent: message\ndata: {"id":1,"result":{"step":"last"}}\n\n';
  assert.deepEqual(parseStreamableBody('text/event-stream', sse), { id: 1, result: { step: 'last' } });
});

test('parseStreamableBody rejects empty or malformed bodies', () => {
  assert.throws(() => parseStreamableBody('application/json', '   '), /Empty MCP response/);
  assert.throws(() => parseStreamableBody('application/json', 'not json'), /Invalid MCP JSON/);
  assert.throws(() => parseStreamableBody('text/event-stream', 'event: ping\n\n'), /no JSON message/);
});

test('initialize sends the bearer token, protocol version, and captures the session id', async () => {
  const calls = [];
  const client = new McpHttpClient('https://mcp.notion.com/mcp', {
    token: 'secret-at',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonRes({ id: 1, result: { serverInfo: { name: 'notion' } } }, { 'mcp-session-id': 'sess-42' }); }
  });
  await client.start();
  assert.equal(calls.length, 2, 'initialize + initialized notification');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-at');
  assert.equal(calls[0].options.headers['MCP-Protocol-Version'], MCP_PROTOCOL_VERSION);
  assert.equal(JSON.parse(calls[0].options.body).method, 'initialize');
  assert.equal(JSON.parse(calls[1].options.body).method, 'notifications/initialized');
  assert.equal(JSON.parse(calls[1].options.body).id, undefined, 'a notification carries no id');
  assert.equal(client.sessionId, 'sess-42');
  assert.equal(calls[1].options.headers['Mcp-Session-Id'], 'sess-42', 'the session id is echoed back');
  assert.equal(client.initialized, true);
});

test('start() is idempotent', async () => {
  let calls = 0;
  const client = new McpHttpClient('https://mcp.notion.com/mcp', { token: 't', fetchImpl: async () => { calls++; return jsonRes({ result: {} }); } });
  await client.start(); await client.start();
  assert.equal(calls, 2, 'the second start() makes no further requests');
});

test('listTools and callTool use the documented JSON-RPC methods', async () => {
  const sent = [];
  const client = new McpHttpClient('https://mcp.notion.com/mcp', {
    token: 't',
    fetchImpl: async (_u, options) => { const body = JSON.parse(options.body); sent.push(body); return jsonRes({ id: body.id, result: { tools: [{ name: 'notion-search' }] } }); }
  });
  const tools = await client.listTools();
  assert.equal(sent.at(-1).method, 'tools/list');
  assert.equal(tools.tools[0].name, 'notion-search');

  await client.callTool('notion-search', { query: 'roadmap' });
  assert.equal(sent.at(-1).method, 'tools/call');
  assert.deepEqual(sent.at(-1).params, { name: 'notion-search', arguments: { query: 'roadmap' } });
});

test('a JSON-RPC error is surfaced as a thrown error', async () => {
  const client = new McpHttpClient('https://mcp.notion.com/mcp', { token: 't', fetchImpl: async () => jsonRes({ id: 1, error: { code: -32601, message: 'no such tool' } }) });
  await assert.rejects(() => client.listTools(), /MCP error on tools\/list: no such tool/);
});

test('an HTTP error is surfaced with its status', async () => {
  const client = new McpHttpClient('https://mcp.notion.com/mcp', {
    token: 't',
    fetchImpl: async () => ({ ok: false, status: 401, headers: headers({ 'content-type': 'application/json' }), text: async () => '{"error":"unauthorized"}' })
  });
  await assert.rejects(() => client.listTools(), /MCP HTTP 401/);
});

test('a request without a usable token fails with actionable guidance', async () => {
  const client = new McpHttpClient('https://mcp.notion.com/mcp', { tokenKey: 'definitely-not-stored', fetchImpl: async () => jsonRes({ result: {} }) });
  await assert.rejects(() => client.listTools(), /ultron notion login/);
});

test('a hung request is aborted at the timeout instead of hanging', async () => {
  const client = new McpHttpClient('https://mcp.notion.com/mcp', {
    token: 't', timeoutMs: 30,
    fetchImpl: (_u, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    })
  });
  await assert.rejects(() => client.listTools(), /timed out/);
});

test('close() resets the session so a new one is negotiated', async () => {
  const client = new McpHttpClient('https://mcp.notion.com/mcp', { token: 't', fetchImpl: async () => jsonRes({ result: {} }, { 'mcp-session-id': 's1' }) });
  await client.start();
  assert.equal(client.sessionId, 's1');
  client.close();
  assert.equal(client.sessionId, null);
  assert.equal(client.initialized, false);
});
