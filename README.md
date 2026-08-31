# Ultron CLI

A secure, **dependency-free**, model-agnostic developer CLI for Node.js 20+. Local-first
interactive chat, subagent DAG pipelines with **explicit quality gates**, lifecycle hooks,
remote MCP, browser OAuth, project intelligence, and resilient provider adapters — with zero
runtime dependencies and no telemetry.

```bash
ultron                        # interactive session on your local model, free
ultron "explain this error"    # ask and stay in the session
ultron pipeline run feature --task "add pagination to /users"
```

**Verified:** `npm test` → **324 tests passing**, serial and deterministic, zero dependencies.

## What makes it different

| | |
|---|---|
| **Zero runtime dependencies** | `package.json` has no `dependencies` block. Nothing to audit, nothing to typosquat, nothing to break on install. |
| **Local-first** | Bare `ultron` talks to your own model via LM Studio. Free, offline, no key. |
| **Bounded by construction** | Every loop, retry, budget, recursion depth **and output buffer** has a cap. `runPipeline` never throws — you always get `{ ok, partial, reason, stages }`. |
| **Gates, not retry loops** | Pipelines can advance only by passing an explicit gate that returns a structured verdict. See [`gauntlet/v1`](#gauntletv1--gates-instead-of-retry-loops). |
| **Tamper-evident history** | Pipeline runs append to a hash-chained audit trail. `ultron audit verify` names the exact line if it was rewritten. |
| **No telemetry** | Credentials come from the environment only; `.env` files are deliberately never read or written. |

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

## `gauntlet/v1` — gates instead of retry loops

`src/gauntlet.mjs` implements an execution-graph contract shared with the
[Alfred harness](https://github.com/tusharbeckham/Alfred). Work advances only by passing an
explicit **gate** that returns a structured verdict — `PASS` / `RETRY` / `REROUTE` /
`ESCALATE` / `ABORT` — and the *engine* decides what happens next, not the model.

A retry loop cannot tell "tests failed" from "the model refused", so it applies the same remedy
forever. Here every rung of the ladder is bounded:

```
RETRY x2  ->  REROUTE x2  ->  ESCALATE x1  ->  ABORT (partial result + reason)
 fix, fix     replan            deep-review     stop, honestly
```

Three guarantees hold regardless of what a gate asks for:

- A third `RETRY` with the **same reason code** is impossible — it becomes `REROUTE`.
- A node that produced **output it already produced** is rerouted, never retried.
- A gate may reject at most **4 times in total**, whatever it calls the failures.

That last one matters most. A live 7B gate defeated the per-code rule by inventing a new reason
code on every attempt — 40 node runs, **zero** forced reroutes. A guarantee keyed on a value the
model chooses is not a guarantee, so total attempts are bounded too, and unrecognised codes fold
into `OTHER` so repeated failures converge on one counter. An unreadable gate **fails closed**
(`ABORT`), never open.

### Why the router is duplicated, not just the schema

Alfred and Ultron are deliberately separate runtimes (Python vs Node, different trust models).
If Ultron ran the same graph with a plain retry loop, then *where* you ran a spec would silently
change what it was allowed to do — the safety guarantee would belong to the runtime instead of
the spec. So both engines carry the same bounds, and a parity test fails the build if they drift:

```bash
node scripts/gauntlet-check.mjs validate <spec.json>   # what Ultron thinks of a spec
node scripts/gauntlet-check.mjs route    <case.json>   # what Ultron would do with a verdict
```

Alfred drives those from `scripts/test_ultron_parity.py` and asserts both engines agree on every
shipped spec and on the whole routing ladder.

## Pipelines you can watch

A pipeline is *waves of parallel stages*, and a scrolling log flattens exactly the structure you
need to see. `pipeline run` draws the waves live instead:

```
[FEATURE] ████████░░░░░░░░  50% 2/4  8.3s
├─ ✓ wave 1
│  └─ ✓ plan
├─ ● wave 2
│  ├─ ✓ code   coder
│  └─ ● test   tester
└─ ○ wave 3
   └─ ○ review
loops review->code
```

A `loop` event **resets the stage it returns to and decrements the completed count** — leaving
re-run work green would claim progress that was undone. The renderer holds no engine state and
consumes the existing `onEvent` callback, so a display bug cannot affect execution. It degrades
to one line per event when stdout is not a TTY, and `--json` output is untouched.

### The UI kit

`src/ui.mjs` is a zero-dependency terminal toolkit used across the CLI: `spinner` (async-safe,
degrades to plain lines when piped), `table` (ANSI-aware column widths that shrink to fit),
`progressBar`, `costMeter`, `codeBlock`, `markdown`, `diff`, and `tree`. `NO_COLOR` is honoured
throughout, and `strip()` makes every renderer testable.

## Guards — the bounds underneath the permission profiles

Permission profiles answer *may this session write files, run shell, reach the web?*.
`src/guards.mjs` answers what is left once the answer is yes.

```bash
ultron audit verify        # is the trail intact, and where was it broken?
ultron audit checkpoint    # witness the current head (see the caveat below)
ultron audit show --limit 5
```

| Guard | The problem it answers |
|---|---|
| `boundedCapture` | `stdout += chunk` on a child that writes gigabytes takes the CLI down with it. Hooks are capped at 1 MiB, commands at 4 MiB, and truncation is **reported** rather than passed off as the whole output. A `preToolUse` hook runs on every tool call, so a chatty hook is the expected case, not an unusual one. |
| `safeResolve` | On Windows a path *string* and the file it opens are different things. UNC and `\\?\` prefixes, NTFS alternate data streams (`notes.txt:payload`), DOS device names (`CON`, `nul.txt`), trailing dots and spaces, and 8.3 short names are all refused; symlinks and junctions are followed with `realpath` so confinement judges the real target. |
| `appendAudit` / `verifyAudit` | Each record hashes the one before it, so an edit or deletion inside the trail is located to the line. **What it does not stop:** whoever can append can also truncate the tail and continue a chain that verifies perfectly — `checkpointAudit` writes a witness elsewhere, and the gap is stated rather than hidden. |
| `redact` | An allowlist of loggable fields, not a denylist of secret-shaped regexes. The trail is append-only, so a secret written once is written forever; an allowlist withholds tomorrow's field by default. Field *names* are kept — knowing a token was supplied reveals nothing. |
| `TokenBucket` | Bounds a runaway agent loop. A bucket rather than a fixed window, because a fixed window permits a double burst across the boundary — exactly the shape a loop produces. |
| `mintToken` / `verifyToken` | Scope- and expiry-bound credentials, with both claims **inside** the HMAC. A token minted for reading cannot be aimed at writing, which is the confused-deputy problem prompt injection relies on. Tokens also carry an issued-at claim, so revoking a whole subject is one timestamp rather than a list of every credential you would have to already know about. |
| `resolveWithin` (in `permissions.mjs`) | Permission profiles used to answer *what* a session may do and say nothing about *where*: `read-only` — the safest profile, and the default — would happily index `C:\Windows\System32` or a user's SSH keys. Paths from the caller now go through the permission bit, then `safeResolve`, then a workspace-root check, in that order. |

### Where the boundary is

```bash
ultron index .                          # fine
ultron index C:\Windows\System32        # refused: outside the workspace
ultron index CON                        # refused: path component 'CON' names a Windows device
ULTRON_WORKSPACE_ROOTS=C:\a;C:\b ultron index C:\b   # two roots, both honoured
ultron index anywhere --profile unrestricted         # deliberately unbounded
```

`unrestricted` has no path boundary on purpose. Without that escape hatch there would be no
way to work on a second checkout, and someone would "fix" it by reaching for a profile they
need even less.

### Why these are byte-identical to Alfred's

Alfred's harness carries the same guards in `scripts/harness_guards.py`, with the same names
and the same wire format. This is the same argument as the gauntlet router parity: a bound one
engine enforces and the other does not is a bound you escape by typing a different binary, and
an audit trail only one engine can read is a trail the other has to be *trusted* about.

So a chain written here verifies under Alfred, and vice versa — asserted, not assumed, by 11
cross-engine tests in Alfred's `scripts/test_ultron_parity.py`. They check that both engines
produce identical canonical JSON, agree on every chain hash, locate a tampered record at the
same line number, accept each other's scoped tokens in both directions, refuse the same
Windows path tricks, and truncate output at the same byte.

Verified locally by `npm test` → `test/guards.test.mjs`, 48 tests, plus `test/permissions.test.mjs`, 15 tests.

**Where parity deliberately stops.** Alfred confines its child processes in a Windows Job
Object — a memory, CPU and process-count ceiling that also covers grandchildren and reaps the
whole tree when the handle closes. Node cannot reach that, or POSIX `setrlimit`, without a
native module.

What Ultron does instead is wrap argv with programs that already confine:

```
prlimit --as=N --cpu=N --nproc=N --fsize=N --  <cmd>
unshare --user --map-current-user --net --      <cmd>
```

Still argv-only and still `shell: false` — the wrapper is an array and the real command follows
after `--`. Ceilings scale with the permission profile (`read-only` gets 512 MiB and 120 s;
`unrestricted` gets none, for the same reason it has no path boundary). Hooks get them too,
since a `preToolUse` hook is the most frequently executed untrusted thing in the CLI.

Three honest limits:

- **Windows gets nothing.** There is no argv-wrapper equivalent, and `confineArgv` returns
  `note: 'windows: no argv-level confinement available'` rather than an unchanged argv that a
  caller might assume worked.
- `--map-current-user`, not `--map-root-user`: the child keeps its uid, because a script
  branching on `geteuid() === 0` should not be handed a reason to take the privileged path.
- A fresh network namespace's loopback is DOWN, so egress isolation blocks `localhost` too. A
  tool that talks to a local model service genuinely needs the network and must not be isolated.

**Verified end to end on Linux**, through the real `runCommand` and `runHook` code paths:

```bash
node scripts/verify-confine-posix.mjs      # must be run on Linux; 14 checks
```

It spends real resources and expects the kernel to refuse: a 400 MB allocation under a 64 MB
ceiling gets `MemoryError`, a `--fsize` ceiling refuses an over-limit write, an isolated child
gets `ENETUNREACH` while a **control** in the same run proves the identical probe reaches the
network unisolated, and an isolated child keeps its real uid. Hooks get the same treatment,
since a `preToolUse` hook is the most frequently executed untrusted thing in the CLI.

It lives in `scripts/` rather than `test/` deliberately: `node --test` collects everything under
`test/`, and on Windows every check here would be a vacuous no-op reported as a failure.

That verification immediately earned its place — it found that `runHook` reported its
confinement on the spawn-failure path but **not** on success, so the one case you would actually
want to audit was the one case with no record of it. A unit test would not have noticed.

## v0.5.0 - subagents, hooks, remote MCP, Notion OAuth

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
