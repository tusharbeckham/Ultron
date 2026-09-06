/**
 * Lightweight .env loader — zero dependencies.
 *
 * Walks up from `startDir` looking for a `.env` file (like git walks up for
 * `.git`). Parses it and populates `process.env` with any keys that are not
 * already set (explicit env vars always win).
 *
 * Supports:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='literal $value'
 *   KEY=   (empty value)
 *   # full-line comments
 *   inline comments after unquoted values
 *   blank lines
 *
 * Does NOT support multi-line values or variable interpolation — keeping it
 * dead-simple and predictable.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, parse as parsePath } from 'node:path';

/**
 * Find the nearest `.env` file by walking up from `startDir`.
 * Returns the absolute path, or `null` if none found.
 */
function findEnvFile(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = resolve(dir, '.env');
    try {
      readFileSync(candidate, 'utf8'); // existence check; content read later
      return candidate;
    } catch { /* not here, keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Parse a `.env` string into a `{ key: value }` map.
 */
function parseEnv(src) {
  const vars = {};
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();

    // Quoted values: strip matching quotes and take content literally.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip inline comment (` # ...`).
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trimEnd();
    }

    vars[key] = value;
  }
  return vars;
}

/**
 * Load the nearest `.env` file into `process.env`.
 *
 * - Existing env vars are never overwritten.
 * - Empty values are skipped (they'd mask a real env var with nothing).
 * - Returns `{ file, loaded }` for diagnostics, or `null` if no file found.
 */
export function loadEnv(startDir = process.cwd()) {
  const file = findEnvFile(startDir);
  if (!file) return null;

  let src;
  try { src = readFileSync(file, 'utf8'); }
  catch { return null; }

  const vars = parseEnv(src);
  const loaded = [];

  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;                    // skip empty
    if (process.env[key] !== undefined) continue; // shell wins
    process.env[key] = value;
    loaded.push(key);
  }

  return { file, loaded };
}
