/**
 * Gemini 2.5 Flash integration for AI-powered git workflows.
 *
 * Zero dependencies — calls the Gemini REST API directly via Node's built-in
 * `fetch`, mirroring Ultron's provider pattern in providers.mjs.
 */

import { runCommand } from './process.mjs';

// ── Configuration ────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-3.6-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_DIFF_BYTES = 500_000;

export function geminiConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

function requireKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      'GEMINI_API_KEY is not set.\n' +
      '  1. Get a key from https://aistudio.google.com/\n' +
      '  2. Add it to your .env file:  GEMINI_API_KEY=your-key\n' +
      '  3. Or export it:  $env:GEMINI_API_KEY = "your-key"'
    );
  }
  return key;
}

// ── Gemini API call ──────────────────────────────────────────────────────────

async function geminiGenerate(prompt, { temperature = 0.2 } = {}) {
  const key = requireKey();
  const url = `${API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${key}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message;
    try { message = JSON.parse(body)?.error?.message; } catch { /* ignore */ }
    throw new Error(`Gemini API error (HTTP ${res.status}): ${message || body.slice(0, 300) || res.statusText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map(p => p.text)
    .join('')
    ?.trim();

  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the staged diff (`git diff --cached`).
 * Warns via `onWarn` if the diff exceeds the safety limit.
 */
export async function getStagedDiff(cwd = process.cwd(), { onWarn } = {}) {
  const { stdout } = await runCommand('git', ['diff', '--cached'], { cwd });
  if (!stdout) return '';
  if (stdout.length > MAX_DIFF_BYTES) {
    onWarn?.(`Staged diff is very large (${(stdout.length / 1024).toFixed(0)} KB). Truncating to ${(MAX_DIFF_BYTES / 1024).toFixed(0)} KB for the model.`);
    return stdout.slice(0, MAX_DIFF_BYTES);
  }
  return stdout;
}

/**
 * Returns the diff between the current branch and a base branch.
 */
export async function getBranchDiff(base = 'main', cwd = process.cwd(), { onWarn } = {}) {
  const { stdout } = await runCommand('git', ['diff', `${base}...HEAD`], { cwd });
  if (!stdout) return '';
  if (stdout.length > MAX_DIFF_BYTES) {
    onWarn?.(`Branch diff is very large (${(stdout.length / 1024).toFixed(0)} KB). Truncating to ${(MAX_DIFF_BYTES / 1024).toFixed(0)} KB for the model.`);
    return stdout.slice(0, MAX_DIFF_BYTES);
  }
  return stdout;
}

/**
 * Returns `git diff --stat` for changelog context.
 */
export async function getDiffStat(base = 'main', cwd = process.cwd()) {
  const { stdout } = await runCommand('git', ['diff', '--stat', `${base}...HEAD`], { cwd });
  return stdout || '';
}

// ── AI generation functions ──────────────────────────────────────────────────

export async function generateCommitMessage(diff) {
  const prompt = `You are an expert Git assistant. Write a concise, standard conventional commit message for the following diff.

Rules:
- Use the conventional commit format: type(scope): description
- Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build
- Keep the subject line under 72 characters
- Add a blank line then optional bullet points for significant changes
- Output ONLY the raw commit message. No markdown, no backticks, no quotes.

Git Diff:
${diff}`;

  return geminiGenerate(prompt, { temperature: 0.2 });
}

export async function generatePRSummary(diff) {
  const prompt = `You are an expert developer writing a GitHub Pull Request description.

Analyze the following diff and create a structured PR description with:

1. **Title**: A concise PR title (one line, no prefix like "PR:" or "Title:")
2. **Overview**: 2-3 sentences summarizing what this PR does and why
3. **Changes**: Bullet points of key modifications grouped by area
4. **Testing**: Suggested testing steps

Format the output as clean markdown. Do NOT wrap the entire output in a code block.

Diff:
${diff}`;

  return geminiGenerate(prompt, { temperature: 0.3 });
}

export async function generateCodeReview(diff) {
  const prompt = `You are a senior engineer performing a thorough code review.

Review the following diff and provide actionable feedback:

For each finding, use this format:
- **[SEVERITY]** file:line — Description of the issue and how to fix it

Severity levels:
- 🔴 CRITICAL — Bugs, security issues, data loss risks
- 🟡 WARNING — Performance issues, potential edge cases, code smells
- 🟢 SUGGESTION — Style improvements, better patterns, readability

End with a brief summary: overall quality assessment and whether you'd approve this PR.

If the code looks good, say so! Don't invent problems.

Diff:
${diff}`;

  return geminiGenerate(prompt, { temperature: 0.3 });
}

export async function generateChangelog(diff, stat) {
  const prompt = `You are a technical writer generating a changelog entry.

Based on the diff and file statistics below, write a structured changelog entry.

Group changes under these categories (omit empty ones):
### Added
### Changed
### Fixed
### Removed
### Security
### Performance

Rules:
- Each item is a concise bullet point
- Focus on user-visible impact, not implementation details
- Use present tense ("Add", "Fix", "Remove")
- Do NOT wrap in a code block

File Statistics:
${stat || '(not available)'}

Diff:
${diff}`;

  return geminiGenerate(prompt, { temperature: 0.3 });
}
