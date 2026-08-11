// Encrypted token store. AES-256-GCM, atomic writes, best-effort 0600.
// Tokens never appear in argv, logs, or session files.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = () => process.env.ULTRON_HOME || path.join(os.homedir(), '.ultron');
const storePath = () => path.join(home(), 'tokens.json');

function machineSeed() {
  let user = 'unknown';
  try { user = os.userInfo().username; } catch { /* container without passwd entry */ }
  return `${os.hostname()}:${user}:ultron-token-store-v1`;
}

function readStore() {
  const file = storePath();
  if (!existsSync(file)) return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.salt) throw new Error('malformed');
    parsed.entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return parsed;
  } catch {
    return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} };
  }
}

function writeStore(store) {
  const dir = home();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = storePath(), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows / unsupported fs */ }
}

const keyFor = salt => scryptSync(machineSeed(), Buffer.from(salt, 'base64'), 32);

function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') };
}

function decrypt(key, record) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
}

export function saveToken(key, value) {
  if (!key) throw new Error('A token key is required');
  const store = readStore();
  store.entries[key] = { ...encrypt(keyFor(store.salt), JSON.stringify(value)), savedAt: new Date().toISOString() };
  writeStore(store);
  return true;
}

export function loadToken(key) {
  const store = readStore();
  const record = store.entries[key];
  if (!record) return null;
  try { return JSON.parse(decrypt(keyFor(store.salt), record)); } catch { return null; }
}

export function deleteToken(key) {
  const store = readStore();
  if (!(key in store.entries)) return false;
  delete store.entries[key];
  writeStore(store);
  return true;
}

export function listTokenKeys() { return Object.keys(readStore().entries); }

export function tokenStorePath() { return storePath(); }

// Test/maintenance helper: remove the whole store directory. Never called by the CLI.
export function destroyStore() { try { rmSync(home(), { recursive: true, force: true }); } catch { /* ignore */ } }
