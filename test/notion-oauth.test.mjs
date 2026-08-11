import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  NOTION_MCP_RESOURCE, NOTION_REST_AUTHORIZE, NOTION_REST_TOKEN, NOTION_VERSION,
  createPkcePair, createState, buildAuthorizeUrl, discoverMcpAuthServer, registerClient,
  startLoopbackReceiver, exchangeCode, refreshAccessToken, needsRefresh
} from '../src/notion-oauth.mjs';

const json = body => ({ ok: true, status: 200, json: async () => body });
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('documented constants are exact', () => {
  assert.equal(NOTION_MCP_RESOURCE, 'https://mcp.notion.com/mcp');
  assert.equal(NOTION_REST_AUTHORIZE, 'https://api.notion.com/v1/oauth/authorize');
  assert.equal(NOTION_REST_TOKEN, 'https://api.notion.com/v1/oauth/token');
  assert.equal(NOTION_VERSION, '2026-03-11');
});

test('createPkcePair produces an S256 challenge over the verifier', () => {
  const { verifier, challenge, method } = createPkcePair();
  assert.equal(method, 'S256');
  assert.match(verifier, /^[A-Za-z0-9\-_]{43}$/);
  assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()));
  assert.notEqual(createPkcePair().verifier, verifier, 'verifier must be random per call');
});

test('buildAuthorizeUrl includes every required OAuth parameter', () => {
  const url = new URL(buildAuthorizeUrl({
    authorizationEndpoint: NOTION_REST_AUTHORIZE, clientId: 'cid',
    redirectUri: 'http://127.0.0.1:5555/callback', state: 'st8', challenge: 'chal', extraParams: { owner: 'user' }
  }));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
  assert.equal(url.searchParams.get('state'), 'st8');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('owner'), 'user');
});

test('buildAuthorizeUrl validates its inputs', () => {
  assert.throws(() => buildAuthorizeUrl({}), /authorizationEndpoint is required/);
  assert.throws(() => buildAuthorizeUrl({ authorizationEndpoint: 'https://x/a' }), /clientId is required/);
  assert.throws(() => buildAuthorizeUrl({ authorizationEndpoint: 'https://x/a', clientId: 'c' }), /redirectUri is required/);
});

test('discovery walks protected-resource then authorization-server metadata', async () => {
  const seen = [];
  const meta = await discoverMcpAuthServer({
    fetchImpl: async url => {
      seen.push(url);
      if (url.endsWith('/.well-known/oauth-protected-resource')) return json({ authorization_servers: ['https://auth.notion.com'] });
      return json({ issuer: 'https://auth.notion.com', authorization_endpoint: 'https://auth.notion.com/authorize', token_endpoint: 'https://auth.notion.com/token', registration_endpoint: 'https://auth.notion.com/register' });
    }
  });
  assert.deepEqual(seen, ['https://mcp.notion.com/.well-known/oauth-protected-resource', 'https://auth.notion.com/.well-known/oauth-authorization-server']);
  assert.equal(meta.authorizationEndpoint, 'https://auth.notion.com/authorize');
  assert.equal(meta.tokenEndpoint, 'https://auth.notion.com/token');
  assert.equal(meta.registrationEndpoint, 'https://auth.notion.com/register');
});

test('discovery fails loudly when metadata is incomplete', async () => {
  await assert.rejects(() => discoverMcpAuthServer({
    fetchImpl: async url => url.includes('protected-resource') ? json({ authorization_servers: ['https://auth.notion.com'] }) : json({ issuer: 'https://auth.notion.com' })
  }), /missing required endpoints/);
});

test('dynamic client registration asks for a public client and returns the id', async () => {
  let body;
  const { clientId, clientSecret } = await registerClient({
    registrationEndpoint: 'https://auth.notion.com/register',
    redirectUri: 'http://127.0.0.1:1/callback',
    fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return json({ client_id: 'dcr-123' }); }
  });
  assert.equal(clientId, 'dcr-123');
  assert.equal(clientSecret, null, 'a public client has no secret');
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(body.redirect_uris, ['http://127.0.0.1:1/callback']);
  assert.equal(body.client_name, 'ultron-cli');
});

test('loopback receiver binds 127.0.0.1 and returns the code on the happy path', { timeout: 10000 }, async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ expectedState: state, timeoutMs: 5000 });
  assert.match(receiver.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(receiver.port > 0);
  const pending = receiver.waitForCode();
  const res = await fetch(`${receiver.redirectUri}?code=abc123&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(await pending, { code: 'abc123' });
});

test('loopback receiver rejects a state mismatch without yielding a code', { timeout: 10000 }, async () => {
  const receiver = await startLoopbackReceiver({ expectedState: 'good-state', timeoutMs: 5000 });
  const pending = receiver.waitForCode();
  const res = await fetch(`${receiver.redirectUri}?code=abc123&state=evil-state`);
  assert.equal(res.status, 400);
  await res.text();
  await assert.rejects(() => pending, /state mismatch/i);
});

test('loopback receiver 404s any other path and close() always settles', { timeout: 10000 }, async () => {
  const receiver = await startLoopbackReceiver({ expectedState: 'st', timeoutMs: 5000 });
  const pending = receiver.waitForCode();
  const res = await fetch(`http://127.0.0.1:${receiver.port}/admin`);
  assert.equal(res.status, 404);
  await res.text();
  receiver.close();
  await assert.rejects(() => pending, /closed before a callback/);
});

test('loopback receiver times out instead of waiting forever', { timeout: 10000 }, async () => {
  const receiver = await startLoopbackReceiver({ expectedState: 'st', timeoutMs: 50 });
  await assert.rejects(() => receiver.waitForCode(), /Timed out after 50ms/);
});

test('loopback receiver surfaces a provider error param', { timeout: 10000 }, async () => {
  const receiver = await startLoopbackReceiver({ expectedState: 'st', timeoutMs: 5000 });
  const pending = receiver.waitForCode();
  const res = await fetch(`${receiver.redirectUri}?error=access_denied&state=st`);
  assert.equal(res.status, 400);
  await res.text();
  await assert.rejects(() => pending, /access_denied/);
});

test('exchangeCode sends PKCE verifier as a public client', async () => {
  let sent, headers;
  const tokens = await exchangeCode({
    tokenEndpoint: NOTION_REST_TOKEN, clientId: 'cid', code: 'the-code',
    redirectUri: 'http://127.0.0.1:9/callback', verifier: 'ver1fier',
    fetchImpl: async (_u, o) => { sent = new URLSearchParams(o.body); headers = o.headers; return json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800, workspace_name: 'Acme' }); }
  });
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(sent.get('code_verifier'), 'ver1fier');
  assert.equal(sent.get('client_id'), 'cid');
  assert.equal(headers.Authorization, undefined, 'public client must not send Basic auth');
  assert.equal(tokens.accessToken, 'at');
  assert.equal(tokens.refreshToken, 'rt');
  assert.equal(tokens.workspaceName, 'Acme');
  assert.ok(Date.parse(tokens.expiresAt) > Date.now());
});

test('exchangeCode uses HTTP Basic when a client secret is configured', async () => {
  let headers, sent;
  await exchangeCode({
    tokenEndpoint: NOTION_REST_TOKEN, clientId: 'cid', clientSecret: 'sec', code: 'c',
    fetchImpl: async (_u, o) => { headers = o.headers; sent = new URLSearchParams(o.body); return json({ access_token: 'at' }); }
  });
  assert.equal(headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(sent.get('client_id'), null, 'confidential client sends credentials in the header only');
});

test('exchangeCode surfaces token endpoint errors', async () => {
  await assert.rejects(() => exchangeCode({
    tokenEndpoint: NOTION_REST_TOKEN, clientId: 'c', code: 'x',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }) })
  }), /HTTP 400.*bad code/);
});

test('exchangeCode requires an access_token in the response', async () => {
  await assert.rejects(() => exchangeCode({ tokenEndpoint: NOTION_REST_TOKEN, clientId: 'c', code: 'x', fetchImpl: async () => json({ token_type: 'bearer' }) }), /no access_token/);
});

test('refreshAccessToken returns the rotated refresh token', async () => {
  let sent;
  const rotated = await refreshAccessToken({
    tokenEndpoint: NOTION_REST_TOKEN, clientId: 'cid', refreshToken: 'old-rt',
    fetchImpl: async (_u, o) => { sent = new URLSearchParams(o.body); return json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 100 }); }
  });
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('refresh_token'), 'old-rt');
  assert.equal(rotated.accessToken, 'new-at');
  assert.equal(rotated.refreshToken, 'new-rt');
});

test('refreshAccessToken keeps the old refresh token when the server omits one', async () => {
  const out = await refreshAccessToken({ tokenEndpoint: NOTION_REST_TOKEN, clientId: 'c', refreshToken: 'keep-me', fetchImpl: async () => json({ access_token: 'a' }) });
  assert.equal(out.refreshToken, 'keep-me');
});

test('needsRefresh respects expiry and skew', () => {
  assert.equal(needsRefresh(null), true);
  assert.equal(needsRefresh({}), true);
  assert.equal(needsRefresh({ accessToken: 'a' }), false, 'no expiry means we cannot know; do not churn');
  assert.equal(needsRefresh({ accessToken: 'a', expiresAt: new Date(Date.now() + 3600000).toISOString() }), false);
  assert.equal(needsRefresh({ accessToken: 'a', expiresAt: new Date(Date.now() + 1000).toISOString() }), true);
  assert.equal(needsRefresh({ accessToken: 'a', expiresAt: new Date(Date.now() - 1000).toISOString() }), true);
});
