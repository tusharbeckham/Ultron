# Ultron CLI

A secure, dependency-free, model-agnostic developer CLI for Node.js 20+ with stateful interactive chat, resilient provider adapters, project intelligence, MCP support, and editor-friendly transports.

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
