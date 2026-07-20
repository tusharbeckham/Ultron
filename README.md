# Ultron CLI

A dependency-free, model-agnostic developer CLI for Node.js 20+ with secure defaults, resilient provider adapters, local project intelligence, MCP support, and editor-friendly JSON transport.

## Highlights in v0.3.0

- **Provider hardening:** streaming, cancellation, bounded retry/backoff, timeout policy, model catalogs, usage/rate-limit metadata, and optional cost estimates.
- **Project intelligence:** ignore-aware indexing, Git context, non-mutating patch validation, and explicitly authorized patch application.
- **Tool boundary:** read-only/balanced/unrestricted permission profiles and an MCP stdio JSON-RPC client.
- **Sessions:** opt-in, versioned JSONL persistence with credential redaction, secure file modes, and JSON/Markdown export.
- **IDE-grade interfaces:** Bash/Zsh/Fish/PowerShell completions, stable JSON output, and `ultron-jsonl/1` editor-agent transport.
- **Distribution:** npm packaging checks, Unix and PowerShell installers, SHA-256 release manifests, and user-key signing workflow.

## Install

```bash
npm install
npm link
ultron doctor
```

Or use `scripts/install.sh` on Unix-like systems or `scripts/install.ps1` on Windows. No runtime dependencies are required.

## Configure providers

Ultron deliberately does not load or save `.env` files. Export only the credentials you need:

```bash
export OPENAI_API_KEY='...'
ultron ask --provider openai --stream 'Review this repository'

export ANTHROPIC_API_KEY='...'
ultron ask --provider anthropic --json 'Design a test plan'

export MOONSHOT_API_KEY='...'
ultron chat --provider kimi --model kimi-k3
```

Generic OpenAI-compatible endpoints use `ULTRON_CUSTOM_BASE_URL`, `ULTRON_CUSTOM_API_KEY`, and `ULTRON_CUSTOM_MODEL`.

## Provider hardening

```bash
ultron capabilities --json
ultron models --provider openai --json
ultron ask --provider anthropic --timeout-ms 30000 --max-retries 3 'Review this design'
```

Defaults use `ULTRON_TIMEOUT_MS`, `ULTRON_MAX_RETRIES`, `ULTRON_RETRY_BASE_MS`, and `ULTRON_RETRY_MAX_MS`. Cost remains `null` unless matching `*_INPUT_USD_PER_MILLION` and `*_OUTPUT_USD_PER_MILLION` values are set, avoiding stale built-in pricing.

## Project intelligence

```bash
# Respects .gitignore and .ultronignore
ultron index . --profile read-only
ultron index . --profile balanced --output .ultron/index.json

ultron git .
ultron patch change.patch                         # git apply --check only
ultron patch change.patch --apply --profile balanced
```

Symlinks are skipped and index size is bounded. Patch application is never implicit.

## Permissions and MCP

The default profile is `read-only`. Inspect profiles with `ultron permissions`.

```bash
ultron mcp tools --profile unrestricted --command node --args '["server.mjs"]'
ultron mcp call --profile unrestricted --command node --args '["server.mjs"]' --tool echo --input '{"value":"hello"}'
```

MCP process launch requires shell permission and uses direct process spawning, not shell interpolation.

## Redacted sessions

```bash
ultron chat --provider openai --session new
ultron ask --provider openai --session project-review 'Continue review'
ultron session export project-review --format md --output review.md
```

Sessions are opt-in and stored as mode-0600 JSONL where supported. Common secret forms are redacted before persistence.

## Shell completions and editor transport

```bash
ultron completion bash
ultron completion zsh
ultron completion fish
ultron completion powershell
```

`ultron serve --provider openai` exposes newline-delimited JSON-RPC. Initialize with method `initialize`, invoke a model with `prompt`, and end with `shutdown`. The returned protocol identifier is `ultron-jsonl/1`; this is a documented equivalent editor transport rather than a false claim of full ACP conformance.

## Existing integrations

- Kiro CLI headless adapter (tool trust remains opt-in with `--trust-all`)
- Claude Code one-shot adapter
- OpenClaw agent adapter
- Notion search/page connector (requires a Notion-enabled permission profile)
- VS Code, VSCodium, Cursor, Antigravity, and Zed launchers
- Bounded agentic loop with a hard maximum of three passes

## Release and verification

```bash
npm test
npm pack --dry-run
zip -r ultron-cli-v0.3.0.zip ultron-cli
node scripts/release.mjs ultron-cli-v0.3.0.zip
ULTRON_GPG_KEY_ID='<your-key>' scripts/sign-release.sh ultron-cli-v0.3.0.zip
```

Ultron creates checksums and provenance locally. It never fabricates a cryptographic signature: signing requires a user-controlled GPG key. Live provider smoke tests require valid user credentials, network access, subscriptions, and provider permissions.
