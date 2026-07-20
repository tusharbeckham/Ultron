import { promises as fs } from 'node:fs';
import path from 'node:path';
const DEFAULT_IGNORES = ['.git', 'node_modules', '.ultron', 'dist', 'build', 'coverage', '*.min.js', '*.map', '*.lock'];
function glob(pattern, value) { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.'); return new RegExp(`(^|/)${escaped}(/|$)`).test(value); }
async function ignoreRules(root) { const rules = [...DEFAULT_IGNORES]; for (const name of ['.gitignore', '.ultronignore']) { try { rules.push(...(await fs.readFile(path.join(root, name), 'utf8')).split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'))); } catch {} } return rules; }
function ignored(rel, rules) { return rules.some(rule => !rule.startsWith('!') && glob(rule.replace(/^\//, ''), rel)); }
function binary(buffer) { return buffer.subarray(0, 8000).includes(0); }
export async function indexProject(root = process.cwd(), { maxFiles = 2000, maxBytes = 1_000_000 } = {}) {
  root = path.resolve(root); const rules = await ignoreRules(root), files = []; let totalBytes = 0, truncated = false;
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name), rel = path.relative(root, full).split(path.sep).join('/'); if (ignored(rel, rules)) continue; if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) await walk(full); else if (entry.isFile()) { const stat = await fs.stat(full); if (files.length >= maxFiles || totalBytes + stat.size > maxBytes) { truncated = true; continue; } const sample = await fs.readFile(full); files.push({ path: rel, bytes: stat.size, binary: binary(sample), modified: stat.mtime.toISOString() }); totalBytes += stat.size; } } }
  await walk(root); return { version: 1, root, generatedAt: new Date().toISOString(), rules, fileCount: files.length, totalBytes, truncated, files };
}
export async function writeIndex(index, destination) { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, JSON.stringify(index, null, 2), { mode: 0o600 }); return destination; }
