# Ultron CLI — v1.0 Target Architecture

> Status: **design, approved for implementation**. Supersedes nothing — `ARCHITECTURE.md`
> describes v0.4.0 as built. This document describes where v1.0 is going and why.
> Researched and written 2026-08-11. Every external fact below carries a source URL.

---

## 0. The answer to the headline question

**Can Ultron use "Notion AI" as a model? No — and no CLI can.**

Notion does not expose Notion AI as an inference endpoint. The developer platform's
"Agent APIs" section contains the MCP server and the External Agents API; both are
**data and tool access to a workspace**, not LLM completions for arbitrary prompts.
There is no documented `POST /v1/ai/complete`-style endpoint.
(source: https://developers.notion.com/guides/mcp/overview,
https://www.notion.com/blog/introducing-developer-platform)

**What Ultron *can* do — and what the Owner actually asked for — is the OAuth part.**
A user opens a browser, logs into their own Notion account (any plan, incl. Business),
approves the connection, and Ultron receives a token it can use to read and write that
workspace. Two supported paths:

| Path | Endpoint | Use it for |
|---|---|---|
| **A. Notion MCP (preferred)** | `https://mcp.notion.com/mcp` (Streamable HTTP) · `https://mcp.notion.com/sse` (legacy) | Tool-level access. OAuth 2.1 + PKCE (S256) + **Dynamic Client Registration (RFC 7591)** — so Ultron needs *no pre-registered client secret*. ~23 tools incl. `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-query-data-sources`. |
| **B. Public connection REST OAuth** | `GET https://api.notion.com/v1/oauth/authorize` → `POST https://api.notion.com/v1/oauth/token` | Direct REST API access. Requires a registered `client_id`/`client_secret` from the Notion developer portal. Returns `access_token` + `refresh_token` + `workspace_id`/`workspace_name`. |

(sources: https://developers.notion.com/guides/mcp/build-mcp-client,
https://developers.notion.com/guides/get-started/authorization,
https://developers.notion.com/reference/refresh-a-token)

So: **Notion is a first-class *tool/data* provider in Ultron, never a model provider.**
Ultron's own model (Kimi / DeepSeek / GLM / local) does the thinking; Notion MCP gives it
hands inside the workspace. The Owner's "log in through the web with your Notion account"
requirement is satisfied by path A (zero secrets to manage) with path B as a fallback for
raw REST work.

Plan-tier caveat worth stating plainly: creating a connection works on **every** plan, but
the AI-backed MCP tools (`notion-query-data-sources` at scale, `notion-query-meeting-notes`,
connected-app search across Slack/Drive) require **Business or Enterprise with Notion AI**.
The `notion-fetch` response carries a `current_tool_access` map — Ultron reads it at runtime
and reports which tools are actually available instead of failing mysteriously.
(source: https://developers.notion.com/guides/mcp/mcp-supported-tools, https://www.notion.com/pricing)

---

## 1. What v1.0 adds

v0.4.0 is a solid single-agent CLI: providers, chat, sessions, indexer, git, MCP client,
permissions, bounded loop. Four things are missing for the Owner's plan:

| Gap | v1.0 answer |
|---|---|
| Only 4 direct model providers; no DeepSeek / GLM / local-first | **Model registry** (`src/models.mjs`) + 3 new providers + `local` |
| Notion needs a hand-pasted `NOTION_ACCESS_TOKEN` | **`src/notion-oauth.mjs`** — browser OAuth with PKCE + DCR + loopback receiver + encrypted token store |
| No subagents — `loop.mjs` is a 3-pass self-review | **`src/subagents.mjs`** — agent registry + DAG runner, modelled on Alfred's `workflows/*.json` |
| No lifecycle hooks | **`src/hooks.mjs`** — `preToolUse` / `postToolUse` / `sessionStart` / `sessionEnd`, deny-capable |

Non-negotiable constraints carried forward from v0.4.0: **zero runtime dependencies**, ESM,
Node ≥ 20, `node --test` only, credentials from env or the OS-scoped token store (never
`.env` loading), and **the CLI never executes model-generated shell commands**.

---

## 2. Layered structure

```
┌──────────────────────────────────────────────────────────────────────┐
│ bin/ultron.mjs            command router, flag parsing, exit codes    │
├──────────────────────────────────────────────────────────────────────┤
│ ORCHESTRATION   subagents.mjs · loop.mjs · hooks.mjs                  │
│                 (DAG waves, fan-in, bounded retries, lifecycle gates) │
├──────────────────────────────────────────────────────────────────────┤
│ CONVERSATION    chat.mjs · interactive.mjs · sessions.mjs             │
│                 (bounded history, compaction, redacted JSONL, resume) │
├──────────────────────────────────────────────────────────────────────┤
│ MODELS          models.mjs (registry) → providers.mjs (adapters)      │
│                 openai · anthropic · kimi · deepseek · zai · local    │
│                 · custom · kiro · claude-code · openclaw              │
├──────────────────────────────────────────────────────────────────────┤
│ TOOLS & DATA    mcp.mjs (stdio) · mcp-http.mjs (remote, NEW)          │
│                 notion.mjs · notion-oauth.mjs (NEW) · indexer · git   │
├──────────────────────────────────────────────────────────────────────┤
│ SAFETY          permissions.mjs · tokens.mjs (NEW, encrypted store)   │
│                 audit.mjs (NEW, append-only log)                      │
└──────────────────────────────────────────────────────────────────────┘
```

New files, all dependency-free:

| File | Responsibility |
|---|---|
| `src/models.mjs` | Declarative registry: id → provider, base URL, env var, context window, price, tier. Single source of truth for `ultron models` and for cost estimation. |
| `src/notion-oauth.mjs` | RFC 9470/8414 discovery → RFC 7591 DCR → PKCE S256 authorize → loopback `127.0.0.1` callback → token exchange → refresh-with-rotation. |
| `src/mcp-http.mjs` | Streamable-HTTP MCP transport (the stdio client stays in `mcp.mjs`). Bearer auth from the token store. |
| `src/tokens.mjs` | Token store at `~/.ultron/tokens.json`, `chmod 600` where supported, AES-256-GCM via `node:crypto` with a machine-derived key. Never logged. |
| `src/subagents.mjs` | Agent definitions + DAG execution with waves, `depends_on`, bounded `loop_to`, per-stage timeout, per-run budget. |
| `src/hooks.mjs` | Hook table loaded from `.ultron/hooks.json`; `preToolUse` may **veto** a tool call. |
| `src/audit.mjs` | Append-only JSONL of every tool call, subagent spawn, and permission decision. |

---

## 3. Model registry

Every model the Owner plans to use, verified against official docs on 2026-08-11.

| Provider key | Base URL | Model IDs | Env var | OpenAI-compatible | Notes |
|---|---|---|---|---|---|
| `kimi` | `https://api.moonshot.ai/v1` | `kimi-k3` | `MOONSHOT_API_KEY` | yes | 1M ctx · $3.00/$15.00 per 1M (cache-hit input $0.30). `.cn` domain is the China mirror. |
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash`, `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | yes (**and** Anthropic-shaped at `/anthropic`) | 1M ctx, 384K out. Flash $0.14/$0.28; Pro $0.435/$0.87. Cheapest capable tier by a mile. |
| `zai` | `https://api.z.ai/api/paas/v4` | `glm-5.2` | `ZAI_API_KEY` | yes | 1M ctx · $1.40/$4.40. `thinking: {type:"enabled"}` for reasoning. `open.bigmodel.cn` is the China endpoint. |
| `local` | `ULTRON_LOCAL_BASE_URL`, default `http://localhost:1234/v1` | whatever is loaded | none required | yes | LM Studio 1234 · Ollama 11434 · llama.cpp 8080 · vLLM 8000. Liveness probed via `GET /v1/models`. **$0.** |
| `openai`, `anthropic`, `custom`, `kiro`, `claude-code`, `openclaw` | unchanged from v0.4.0 | | | | |

(sources: https://platform.kimi.ai/docs/api/overview · https://api-docs.deepseek.com/news/news260424 ·
https://api-docs.deepseek.com/guides/anthropic_api · https://docs.z.ai/guides/llm/glm-5.2)

**Honest note on "local":** Kimi K3 (2.8T MoE), DeepSeek V4-Pro (1.6T) and GLM-5.2 (753B MoE)
have open weights, but none runs on a normal desktop — quantized GGUFs are 160 GB–1.5 TB.
"Local models" on this machine realistically means small coders (Qwen2.5-Coder-7B class) via
LM Studio; the big three are **API models**. The architecture treats `local` as a
base-URL-configurable OpenAI-compatible endpoint so the distinction is a config choice, not a
code change.

### Routing ladder (mirrors Alfred's `token-economy`)

```
tier 0  local              free        boilerplate, regex, single-file edits, drafts
tier 1  deepseek-v4-flash  ~$0.14/1M   bulk work, summarization, extraction, most coding
tier 2  glm-5.2            ~$1.40/1M   reasoning-heavy coding, thinking mode
tier 3  deepseek-v4-pro    ~$0.44/1M   hard engineering (cheap for its class — prefer over kimi)
tier 4  kimi-k3            ~$3.00/1M   agentic long-horizon work, 1M-ctx document reasoning
```
`ultron route --task "<description>"` prints the recommended tier and the reason. Escalation
is explicit; Ultron never silently upgrades a tier.

---

## 4. Notion OAuth flow (path A, MCP, PKCE + DCR)

```
ultron notion login
   │
   ├─1 GET https://mcp.notion.com/.well-known/oauth-protected-resource   (RFC 9470)
   │      → authorization_server URL
   ├─2 GET <as>/.well-known/oauth-authorization-server                    (RFC 8414)
   │      → authorization_endpoint, token_endpoint, registration_endpoint
   ├─3 POST <registration_endpoint>                                       (RFC 7591)
   │      { client_name:"ultron-cli", redirect_uris:["http://127.0.0.1:<port>/callback"],
   │        grant_types:["authorization_code","refresh_token"],
   │        token_endpoint_auth_method:"none" }        → client_id   ← NO SECRET NEEDED
   ├─4 start loopback HTTP server on 127.0.0.1:<ephemeral port>, path /callback only
   ├─5 verifier = base64url(random 32B);  challenge = base64url(sha256(verifier))
   │   open browser →  <authorization_endpoint>?response_type=code
   │        &client_id=…&redirect_uri=…&state=<random>
   │        &code_challenge=<challenge>&code_challenge_method=S256
   │   ── user logs into Notion in the browser, picks the workspace + pages ──
   ├─6 callback receives ?code=…&state=…   → verify state, then close the server
   ├─7 POST <token_endpoint>  grant_type=authorization_code
   │        &code&redirect_uri&client_id&code_verifier=<verifier>
   │      → { access_token, refresh_token, expires_in }        (~8h access token)
   └─8 tokens.mjs: encrypt + store under key "notion". Print workspace name only.
```

Refresh: `grant_type=refresh_token`. Notion **rotates the refresh token on every use**
(refresh max 180 days absolute / 30 days idle), so the store must write the new refresh token
atomically or the connection is lost. Implemented as write-temp-then-rename.
(source: https://developers.notion.com/guides/mcp/build-mcp-client)

Path B (REST public connection) reuses steps 4–8 with `client_id`/`client_secret` from
`NOTION_OAUTH_CLIENT_ID`/`NOTION_OAUTH_CLIENT_SECRET` and HTTP Basic auth on the token call,
against `https://api.notion.com/v1/oauth/{authorize,token}`.

### Security rules for the OAuth module
1. Redirect URI is **always** `http://127.0.0.1` — never `localhost` (DNS rebinding), never a
   public URL. Port is ephemeral, server lives only for the duration of the flow, and serves
   exactly one path.
2. `state` is compared in constant time; a mismatch aborts without exchanging the code.
3. The auth code never touches argv, the shell, a log, or a session file.
4. Tokens live only in the encrypted store. `audit.mjs` records *that* a token was used, never
   its value. Redaction on the session writer already covers `Bearer` patterns.
5. `notion` capability stays gated by `permissions.mjs` — `read-only` profile cannot use it.
6. `ultron notion logout` deletes the stored tokens; **no revocation endpoint is documented**,
   so the CLI says so plainly rather than implying remote revocation.

### Commands
```
ultron notion login   [--path mcp|rest] [--no-browser]   # prints the URL if --no-browser
ultron notion status                                     # workspace, expiry, tool access map
ultron notion logout
ultron notion search <query>                             # unchanged, now token-store backed
ultron notion tools                                      # tools/list via mcp-http
ultron notion call --tool notion-search --input '{...}'
```

---

## 5. Subagents

Ultron's subagents deliberately copy the shape that already works in Alfred
(`workflows/*.json` + `scripts/workflow.py`) so specs are portable between the two.

Agent definition — `.ultron/agents/<name>.json`:
```json
{
  "name": "coder",
  "description": "Implements a change to spec",
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "systemPrompt": "You implement exactly what is specified…",
  "tools": ["fileRead", "fileWrite"],
  "permissionProfile": "balanced",
  "maxTokens": 4096
}
```

Pipeline spec — `.ultron/pipelines/<name>.json`:
```json
{
  "name": "feature",
  "stages": [
    { "name": "plan",   "agent": "planner",  "prompt": "{task}" },
    { "name": "code",   "agent": "coder",    "depends_on": ["plan"], "timeout": 300 },
    { "name": "test",   "agent": "tester",   "depends_on": ["code"],
      "loop_to": { "target": "code", "trigger": "TESTS_FAIL", "max_iterations": 2,
                   "backoff": { "baseMs": 1000, "jitter": true } } },
    { "name": "review", "agent": "reviewer", "depends_on": ["test"] }
  ],
  "budget": { "maxStageRuns": 12, "maxUsdEstimate": 1.00 }
}
```

Runner guarantees — these are the "won't crash" properties:
- Validate first: unique names, resolvable `depends_on`, **no cycles**, `loop_to.target` exists.
- Compute parallel **waves** by topological level; run a wave concurrently with a concurrency cap.
- Per-stage `timeout` with `AbortController`; a timeout is a stage failure, not a process crash.
- Bounded `loop_to` with exponential backoff + jitter.
- Per-run `budget` on stage executions **and** on estimated USD (from the registry prices) —
  exceeding either aborts with a partial result, never silently overspends.
- One failed stage fails only its dependents; independent branches keep running.
- Always return `{ ok, stages: {…}, partial: bool, reason }`. Non-zero exit on `partial`.
- Depth cap of 3: a subagent may not spawn a pipeline deeper than 3 levels.

```
ultron agents                                  # list agent definitions
ultron pipeline plan   feature --task "…"      # preview waves, spawn nothing
ultron pipeline graph  feature                 # mermaid
ultron pipeline run    feature --task "…" [--budget 8] [--concurrency 3]
```

---

## 6. Hooks

`.ultron/hooks.json`:
```json
{
  "sessionStart": [{ "command": "pwsh", "args": ["-File",".ultron/hooks/start.ps1"], "timeoutMs": 5000 }],
  "preToolUse":   [{ "matcher": "fileWrite", "command": "node", "args": [".ultron/hooks/guard.mjs"], "timeoutMs": 5000, "canDeny": true }],
  "postToolUse":  [{ "matcher": "shell",     "command": "node", "args": [".ultron/hooks/audit.mjs"], "timeoutMs": 5000 }],
  "sessionEnd":   [{ "command": "node", "args": [".ultron/hooks/summary.mjs"] }]
}
```

Rules: hooks are spawned with `shell: false` and an argv array — **never** string
interpolation. The tool-call payload arrives on **stdin as JSON**, not in argv, so no
untrusted value can reach a command line. A `preToolUse` hook with `canDeny` that exits
non-zero **vetoes** the tool call. Every hook has a mandatory timeout; a timeout is treated as
a deny for `canDeny` hooks and as a warning otherwise. Hook failures are logged and never
crash the session. Hook config is read-only to the agent — a model cannot edit
`.ultron/hooks.json` because `fileWrite` denies `.ultron/**` by default.

---

## 7. Trust boundaries (v1.0)

Extends the ten boundaries in `ARCHITECTURE.md`:

11. **Token store** is encrypted at rest, `600`, and the only source of OAuth credentials.
    No token is ever written to a session file, log, or argv.
12. **OAuth receiver** binds `127.0.0.1` on an ephemeral port, serves one path, and dies with
    the flow. `state` is verified before any code exchange.
13. **Remote MCP** (`mcp-http.mjs`) allows only `https://` origins on an explicit allowlist
    (default: `mcp.notion.com`). MCP tool *output* is untrusted data, never instructions.
14. **Subagents** inherit a permission profile that can only be **narrowed**, never widened,
    relative to the parent. Depth ≤ 3.
15. **Hooks** receive payloads on stdin, run with `shell: false`, and are timeout-bounded.
    Only `preToolUse` hooks marked `canDeny` may veto.
16. **Budgets** are enforced before each provider call, not after — the run aborts with a
    partial result rather than exceeding the cap.
17. **Model output is never executed.** Unchanged and absolute: no shell, no `eval`.

---

## 8. Delivery order

| Phase | Scope | Status | Verification |
|---|---|---|---|
| **1** | `models.mjs` registry + `deepseek`/`zai`/`local` providers + `registry`/`route` | **DONE** | `test/models.test.mjs`, `test/newproviders.test.mjs` |
| **2** | `tokens.mjs` + `notion-oauth.mjs` (discovery, DCR, PKCE, loopback, refresh) | **DONE** | `test/tokens.test.mjs`, `test/notion-oauth.test.mjs` (stub auth server on 127.0.0.1) |
| **3** | `mcp-http.mjs` + `notion login/status/logout/tools/call` wiring | **DONE** | `test/mcp-http.test.mjs` |
| **4** | `hooks.mjs` + deny semantics | **DONE** | `test/hooks.test.mjs` (allow, deny, non-canDeny cannot veto, timeout-as-deny) |
| **5** | `subagents.mjs` DAG runner + `agents`/`pipeline plan|graph|run` | **DONE** | `test/subagents.test.mjs`, `test/e2e-pipeline.test.mjs` |
| **6** | README/completions/`doctor` extensions, SHA-256 manifest | partial | `npm test` green; completions + doctor not yet extended |

Whole suite: `npm test` → **127 tests, 127 pass** (serial, 30s per-test cap). Live provider and
live Notion checks require the Owner's own credentials and are **not** simulated or faked.
