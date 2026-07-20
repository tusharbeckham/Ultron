# Security model

Ultron reads credentials from environment variables and never persists them. Never commit `.env` or paste secrets into prompts.

- Default permission profile is `read-only`; use `--profile balanced` or `unrestricted` only for explicit operations.
- MCP server launch requires shell permission and uses direct process spawning without shell interpolation.
- Patch review is non-mutating by default; `--apply` is separate and requires file-write permission.
- Sessions are opt-in, redact common credential forms, use versioned JSONL, and are stored with mode `0600` where supported.
- Project indexing follows ignore rules, skips symlinks, and has file/byte limits.
- Kiro tool trust remains opt-in with `--trust-all`.
- The bounded loop never executes model-generated commands.
- Cost values are estimates only and remain unavailable unless the user configures prices.
- Release manifests include SHA-256 provenance. Cryptographic signatures require an external user-controlled signing key and are not fabricated.

Prefer scoped, short-lived provider keys and provider-side spending limits. Report vulnerabilities privately before public disclosure.
