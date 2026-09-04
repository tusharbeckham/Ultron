// Notion OAuth: RFC 9470 discovery -> RFC 8414 metadata -> RFC 7591 dynamic client
// registration -> PKCE S256 authorization code -> loopback receiver -> token exchange/refresh.
//
// Notion does NOT expose Notion AI as an inference endpoint. This module authorizes
// DATA and TOOL access to a workspace. See docs/architecture-v1.md section 0.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export const NOTION_MCP_RESOURCE = 'https://mcp.notion.com/mcp';
export const NOTION_MCP_SSE = 'https://mcp.notion.com/sse';
export const NOTION_REST_AUTHORIZE = 'https://api.notion.com/v1/oauth/authorize';
export const NOTION_REST_TOKEN = 'https://api.notion.com/v1/oauth/token';
export const NOTION_VERSION = '2026-03-11';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Discovery failed for ${url}: HTTP ${res.status}`);
  return res.json();
}

/** RFC 9470 protected-resource metadata, then RFC 8414 authorization-server metadata. */
export async function discoverMcpAuthServer({ resource = NOTION_MCP_RESOURCE, fetchImpl = fetch } = {}) {
  const origin = new URL(resource).origin;
  const prm = await getJson(`${origin}/.well-known/oauth-protected-resource`, fetchImpl);
  const issuer = (prm.authorization_servers && prm.authorization_servers[0]) || prm.authorization_server || origin;
  const asOrigin = new URL(issuer).origin;
  const meta = await getJson(`${asOrigin}/.well-known/oauth-authorization-server`, fetchImpl);
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error('Authorization server metadata is missing required endpoints');
  return {
    issuer: meta.issuer || issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint || null,
    scopesSupported: meta.scopes_supported || []
  };
}

/** RFC 7591 dynamic client registration for a public client (no secret). */
export async function registerClient({ registrationEndpoint, redirectUri, clientName = 'ultron-cli', fetchImpl = fetch } = {}) {
  if (!registrationEndpoint) throw new Error('registrationEndpoint is required');
  if (!redirectUri) throw new Error('redirectUri is required');
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });
  if (!res.ok) throw new Error(`Dynamic client registration failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.client_id) throw new Error('Dynamic client registration returned no client_id');
  return { clientId: body.client_id, clientSecret: body.client_secret || null };
}

export function createPkcePair() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), method: 'S256' };
}

export function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, state, challenge, scope, extraParams = {} } = {}) {
  if (!authorizationEndpoint) throw new Error('authorizationEndpoint is required');
  if (!clientId) throw new Error('clientId is required');
  if (!redirectUri) throw new Error('redirectUri is required');
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (state) url.searchParams.set('state', state);
  if (challenge) { url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', 'S256'); }
  if (scope) url.searchParams.set('scope', scope);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  return url.toString();
}

export function createState() { return b64url(randomBytes(16)); }

function sameState(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const PAGE = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ultron</title></head><body><main><h1>${body}</h1><p>You can close this tab and return to the terminal.</p></main></body></html>`;

/**
 * Loopback receiver: binds 127.0.0.1 on an ephemeral port and serves only /callback.
 * Closes itself after the first callback. Never binds a public interface.
 */
export async function startLoopbackReceiver({ expectedState, timeoutMs = 300000, path: callbackPath = '/callback' } = {}) {
  let settle, settled = false, timer = null;
  const done = new Promise((resolve, reject) => {
    settle = {
      resolve: value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      reject: error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } }
    };
  });
  // Guard the promise itself so a caller that only uses close() can never trigger an
  // unhandled rejection. waitForCode() returns THIS promise (not a derived one) so the
  // guard keeps applying no matter when the caller attaches its handler.
  done.catch(() => {});

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname !== callbackPath) { res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Not found'); return; }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const head = { 'Content-Type': 'text/html', Connection: 'close' };
    if (error) {
      res.writeHead(400, head).end(PAGE('Authorization failed.'));
      settle.reject(new Error(`Authorization denied: ${error}`));
    } else if (expectedState != null && !sameState(expectedState, state ?? '')) {
      res.writeHead(400, head).end(PAGE('State mismatch — request rejected.'));
      settle.reject(new Error('OAuth state mismatch; the authorization code was not exchanged'));
    } else if (!code) {
      res.writeHead(400, head).end(PAGE('No authorization code received.'));
      settle.reject(new Error('No authorization code in the callback'));
    } else {
      res.writeHead(200, head).end(PAGE('Connected. Ultron has your authorization.'));
      settle.resolve({ code });
    }
    // Let the response flush, then tear the listener down for good.
    res.on('finish', () => shutdown());
  });

  // Drop keep-alive sockets too, or the server never actually closes and the process hangs.
  const shutdown = () => {
    try { server.closeAllConnections?.(); } catch { /* older runtime */ }
    try { server.close(); } catch { /* already closed */ }
  };

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref?.();
  const { port } = server.address();
  const timer2 = setTimeout(() => { settle.reject(new Error(`Timed out after ${timeoutMs}ms waiting for the OAuth callback`)); shutdown(); }, timeoutMs);
  timer = timer2;
  // NOT unref'd. The listening server above is unref'd on purpose - an idle socket has no
  // business holding the process open - but that leaves this timer as the only thing that can
  // keep the loop alive long enough to fire, and an unref'd timer cannot. With both unref'd,
  // nothing kept the loop alive and the promise never settled: Linux CI reported it as four
  // cancelled tests. `settle` clears it on both resolve and reject, so not unref'ing cannot
  // hold the process open past the callback.

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
    // close() ALWAYS settles the promise so no caller can wait forever.
    close: () => { settle.reject(new Error('OAuth receiver closed before a callback arrived')); shutdown(); },
    waitForCode: () => done
  };
}

async function postForm(tokenEndpoint, params, { clientSecret, clientId, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  else params.set('client_id', clientId);
  const res = await fetchImpl(tokenEndpoint, { method: 'POST', headers, body: params.toString() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token endpoint error HTTP ${res.status}: ${body.error_description || body.error || body.message || 'unknown'}`);
  return body;
}

function normalizeTokens(body) {
  if (!body.access_token) throw new Error('Token response contained no access_token');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    tokenType: body.token_type || 'bearer',
    expiresIn: body.expires_in ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null,
    scope: body.scope || null,
    workspaceId: body.workspace_id || null,
    workspaceName: body.workspace_name || null,
    botId: body.bot_id || null
  };
}

export async function exchangeCode({ tokenEndpoint, clientId, clientSecret = null, code, redirectUri, verifier, fetchImpl = fetch } = {}) {
  if (!code) throw new Error('code is required');
  const params = new URLSearchParams({ grant_type: 'authorization_code', code });
  if (redirectUri) params.set('redirect_uri', redirectUri);
  if (verifier) params.set('code_verifier', verifier);
  return normalizeTokens(await postForm(tokenEndpoint, params, { clientId, clientSecret, fetchImpl }));
}

/** Notion rotates the refresh token on every use — the caller MUST persist the returned one. */
export async function refreshAccessToken({ tokenEndpoint, clientId, clientSecret = null, refreshToken, fetchImpl = fetch } = {}) {
  if (!refreshToken) throw new Error('refreshToken is required');
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const tokens = normalizeTokens(await postForm(tokenEndpoint, params, { clientId, clientSecret, fetchImpl }));
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

/** True when the stored token is missing, has no expiry, or expires within `skewMs`. */
export function needsRefresh(stored, skewMs = 120000) {
  if (!stored?.accessToken) return true;
  if (!stored.expiresAt) return false;
  return Date.parse(stored.expiresAt) - Date.now() <= skewMs;
}
