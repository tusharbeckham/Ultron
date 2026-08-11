# Ultron CLI

A secure, **dependency-free**, model-agnostic developer CLI for Node.js 20+. Local-first
interactive chat, subagent DAG pipelines, lifecycle hooks, remote MCP, browser OAuth, project
intelligence, and resilient provider adapters — with zero runtime dependencies and no telemetry.

```bash
ultron                       # interactive session on your local model, free
ultron "explain this error"   # ask and stay in the session
ultron pipeline run feature --task "add pagination to /users"
```

**Verified:** `npm test` → 145 tests passing, serial and deterministic.

## Just run it

```bash
ultron
```

That opens an interactive session on **Alfred-Coder**, your fine-tuned local model, served by
LM Studio. Free, offline, no API key.

```
ULTRON interactive · alfred:alfred-coder-7b · session 1786481083699-5f8f8e06
/help for commands · /exit to leave · Ctrl+C cancels a reply

› what is 2+2?
alfred:alfred-coder-7b ▍
4
42→17 tok · 1.2s

›
```

Ask something straight away and stay in the session afterwards:

```bash
ultron "write a powershell one-liner to find files over 100MB"
```

Anything that isn't a known command is treated as a prompt, so you never have to remember
`chat`. Conversation history is sent with every turn, each turn is persisted for `/resume`,
and `Ctrl+C` cancels an in-flight reply without ending the session.

### Pointing it at your model

| Variable | Default | Purpose |
|---|---|---|
| `ALFRED_MODEL` | `alfred-coder-7b` | the model id LM Studio has loaded |
| `ALFRED_BASE_URL` | `http://localhost:1234/v1` | LM Studio; Ollama is `:11434/v1`, llama.cpp `:8080/v1`, vLLM `:8000/v1` |
| `ULTRON_DEFAULT_PROVIDER` | `alfred` | what bare `ultron` uses |

If the server isn't up, Ultron tells you exactly what to run rather than dumping a connection
error, and it warns when a *different* model is loaded than the one you asked for.

### In-session commands

```text
/help                  /exit                 /clear
/provider <name>       /model [id|default]   /context
/index [path]          /git [path]           /add <file>     /drop <file|all>
/multi                 /save                 /resume <session-id>
```

`/model` on its own reports the active model; `/model default` clears an override.
Switch tiers mid-conversation without losing context: `/provider deepseek` then
`/model deepseek-v4-flash`.

## v0.5.0 — subagents, hooks, remote MCP, Notion OAuth

Ultron is now an orchestrator, not just a chat client.

### Models

Four verified API providers plus a configurable local endpoint. Prices are per 1M tokens.

| Provider | Model id | Env var | Price in/out |
|---|---|---|---|
| `alfred` | `alfred-coder-7b` | none needed | **free** (local, default) |
| `local` | whatever is loaded | none needed | **free** |
| `deepseek` | `deepseek-v4-flash` | `DEEPSEEK_API_KEY` | $0.14 / $0.28 |
| `zai` | `glm-5.2` | `ZAI_API_KEY` | $1.40 / $4.40 |
| `deepseek` | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | $0.435 / $0.87 |
| `kimi` | `kimi-k3` | `MOONSHOT_API_KEY` | $3.00 / $15.00 |

`local` points at `ULTRON_LOCAL_BASE_URL` (default LM Studio `http://localhost:1234/v1`;
Ollama is `:11434/v1`, llama.cpp `:8080/v1`, vLLM `:8000/v1`). No API key required.

```bash
ultron registry                       # the whole model table with prices
ultron route "fix a typo"             # -> tier 0, local, free
ultron route "threat model the auth"  # -> tier 3, deepseek-v4-pro
```

Routing never escalates silently — `route` explains its choice and you pass the model yourself.

### Notion

**Notion AI is not an inference endpoint.** No API lets an external program send an arbitrary
prompt to Notion AI; Notion's Agent APIs are workspace *data and tool* access. Ultron therefore
treats Notion as a tool provider, never a model provider.

What does work is browser OAuth against your own account:

```bash
ultron notion login              # opens a browser; PKCE + dynamic client registration
ultron notion status             # workspace, expiry, whether a refresh is due
ultron notion tools              # tools/list over remote MCP
ultron notion call --tool notion-search --input '{"query":"roadmap"}'
ultron notion logout
```

`login` needs **no client secret** — it registers a public client dynamically (RFC 7591) and
uses PKCE S256 with a loopback receiver on `127.0.0.1`. Use `--path rest` with
`NOTION_OAUTH_CLIENT_ID`/`NOTION_OAUTH_CLIENT_SECRET` for the classic REST connection instead.
Tokens are stored AES-256-GCM encrypted in `~/.ultron/tokens.json`, never in a session file or
argv. Notion rotates refresh tokens on every use, and the store persists the new one atomically.

Creating a connection works on any Notion plan; the AI-backed MCP tools require Business or
Enterprise with Notion AI. Ultron reads the runtime tool-access map rather than failing opaquely.

### Subagents

Agents live in `.ultron/agents/<name>.json`, pipelines in `.ultron/pipelines/<name>.json`.
Four example agents and two pipelines ship in the repo.

```bash
ultron agents                                   # list agent definitions
ultron pipeline plan  feature                   # parallel waves, spawns nothing
ultron pipeline graph feature                   # mermaid
ultron pipeline run   feature --task "..." [--budget 8] [--concurrency 3]
```

The runner is built to degrade rather than hang or overspend:

- validates first — unique names, resolvable `depends_on`, **no cycles**, bounded `loop_to`
- computes parallel waves automatically and caps concurrency (default 4)
- per-stage `timeout`; a timeout is a stage failure, not a crashed run
- bounded `loop_to` with exponential backoff + jitter, then gives up and says so
- per-run budget on **stage count and estimated USD**, checked *before* each call
- a failed stage blocks only its dependents; independent branches keep going
- depth capped at 3; `runPipeline` never throws — you always get `{ ok, partial, reason, stages }`
- exits non-zero on a partial result

### Hooks

`.ultron/hooks.json` wires `sessionStart`, `preToolUse`, `postToolUse`, `sessionEnd`.
Hooks are spawned with an argv array and `shell: false`, and the tool-call payload arrives on
**stdin as JSON** — so no untrusted value ever reaches a command line. A `preToolUse` hook
marked `canDeny` that exits non-zero **vetoes the call before any provider request is made**.
A `canDeny` timeout is treated as a deny (fail closed). Hook failures never crash the session.

## v0.4.0 — True interactive chat

Start a persistent conversation:

```bash
ultron chat --provider openai --session new
```

Ultron now sends bounded conversation history with every turn instead of treating each line as an unrelated one-shot prompt. Direct APIs receive structured messages; CLI adapters receive a clearly delimited transcript. Sessions are redacted before persistence and can be resumed.

### Interactive commands

```text
/help                 Show commands
/clear                Clear conversation memory
/exit                 Leave chat
/provider <name>      Switch provider
/model <id>           Switch model; "default" clears override
/context              Show memory and attachments
/index [path]         Add an ignore-aware project index summary
/git [path]           Add Git branch/status/diff context
/add <file>            Attach a project-local text file
/drop <file|all>       Remove attachments
/multi                 Multiline input; finish with a single .
/save                  Show active session id
/resume <session-id>   Restore saved turns
```

`Ctrl+C` during a direct API response cancels that response while keeping the chat alive. Context is bounded by `ULTRON_CHAT_MAX_CHARS` (default 60,000) or `--max-context-chars`. Old messages are omitted deterministically when needed. File attachment is read-only, project-root constrained, size bounded, and rejects binaries.

Examples:

```bash
ultron chat --provider anthropic --session architecture-review
ultron chat --provider claude-code --session new
ultron chat --provider kimi --model kimi-k3 --session new
```

For Claude Code, Kiro, and OpenClaw adapters, Ultron supplies the bounded transcript to each vendor CLI invocation. It does not claim or depend on undocumented vendor-native session identifiers.

## Existing capabilities

- OpenAI Responses, Anthropic Messages, Kimi/Moonshot, and generic OpenAI-compatible APIs
- Streaming, cancellation, bounded retry/backoff, timeouts, model catalogs, usage/rate-limit metadata
- Kiro, Claude Code, and OpenClaw CLI adapters
- Ignore-aware project indexing and Git-aware safe patch review
- Read-only, balanced, and unrestricted permission profiles
- MCP stdio JSON-RPC client
- Redacted JSONL sessions with JSON and Markdown export
- Bash, Zsh, Fish, and PowerShell completions
- `ultron-jsonl/1` editor-agent transport
- Unix and PowerShell installer scripts
- SHA-256 release manifests and user-controlled GPG signing workflow

## Install and verify

```bash
npm install
npm test
npm link
ultron doctor
```

## Provider configuration

Ultron reads credentials only from environment variables and deliberately does not load or save `.env` files.

```bash
export OPENAI_API_KEY='...'
ultron chat --provider openai --session new

export ANTHROPIC_API_KEY='...'
ultron chat --provider anthropic --session new

export MOONSHOT_API_KEY='...'
ultron chat --provider kimi --session new
```

Generic OpenAI-compatible endpoints use `ULTRON_CUSTOM_BASE_URL`, `ULTRON_CUSTOM_API_KEY`, and `ULTRON_CUSTOM_MODEL`.

## Project intelligence

```bash
ultron index .
ultron git .
ultron patch change.patch
ultron patch change.patch --apply --profile balanced
```

Patch application is never implicit. The bounded agentic `run` command remains capped at three passes and never executes model-generated shell commands.

## Release signing

```bash
npm test
npm pack --dry-run
node scripts/release.mjs ultron-cli-v0.4.0.zip
ULTRON_GPG_KEY_ID='<your-key>' scripts/sign-release.sh ultron-cli-v0.4.0.zip
```

On Windows PowerShell:

```powershell
gpg --armor --detach-sign --local-user YOUR_KEY_FINGERPRINT .\ultron-cli-v0.4.0.zip
gpg --verify .\ultron-cli-v0.4.0.zip.asc .\ultron-cli-v0.4.0.zip
```

Ultron never fabricates a signature. Cryptographic release signing requires the user's private GPG key. Live provider smoke tests require the user's credentials and provider access.
