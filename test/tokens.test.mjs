import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ultron-tokens-'));
process.env.ULTRON_HOME = tmp;
const { saveToken, loadToken, deleteToken, listTokenKeys, tokenStorePath } = await import('../src/tokens.mjs');

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('loadToken returns null for a missing key', () => {
  assert.equal(loadToken('nope'), null);
});

test('save / load round-trips the full token object', () => {
  const value = { accessToken: 'secret-access-token-value', refreshToken: 'secret-refresh-token-value', workspaceName: 'Acme' };
  saveToken('notion', value);
  assert.deepEqual(loadToken('notion'), value);
});

test('the token value is not stored in plaintext on disk', () => {
  saveToken('notion', { accessToken: 'PLAINTEXT_CANARY_12345', refreshToken: 'ROTATE_CANARY_67890' });
  const file = tokenStorePath();
  assert.ok(existsSync(file), 'store file exists');
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('PLAINTEXT_CANARY_12345'), 'access token must be encrypted at rest');
  assert.ok(!raw.includes('ROTATE_CANARY_67890'), 'refresh token must be encrypted at rest');
  assert.ok(raw.includes('"salt"') && raw.includes('"iv"') && raw.includes('"tag"'), 'AES-GCM metadata present');
  assert.equal(loadToken('notion').accessToken, 'PLAINTEXT_CANARY_12345', 'still decryptable');
});

test('multiple keys coexist and are listable', () => {
  saveToken('notion', { accessToken: 'a' });
  saveToken('other', { accessToken: 'b' });
  const keys = listTokenKeys().sort();
  assert.ok(keys.includes('notion') && keys.includes('other'));
  assert.equal(loadToken('other').accessToken, 'b');
});

test('deleteToken removes only the requested key', () => {
  saveToken('notion', { accessToken: 'a' });
  saveToken('other', { accessToken: 'b' });
  assert.equal(deleteToken('other'), true);
  assert.equal(loadToken('other'), null);
  assert.equal(loadToken('notion').accessToken, 'a');
  assert.equal(deleteToken('other'), false, 'deleting a missing key reports false');
});

test('saveToken requires a key', () => {
  assert.throws(() => saveToken('', { accessToken: 'x' }), /token key is required/);
});

test('writes are atomic — no .tmp file is left behind', () => {
  saveToken('notion', { accessToken: 'x' });
  assert.equal(existsSync(`${tokenStorePath()}.tmp`), false);
});
