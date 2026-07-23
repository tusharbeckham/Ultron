# Security model

Ultron reads credentials from environment variables and never persists them. Never commit `.env` or paste secrets into prompts.

- Interactive history is bounded and redacted before persistence.
- `/add` accepts only project-local text files, rejects binary content, and enforces a size limit.
- `/index` follows ignore rules and size limits; `/git` is read-only.
- `Ctrl+C` cancels supported direct API responses while preserving the session.
- Default permission profile is `read-only`; use broader profiles only for explicit operations.
- MCP launch requires shell permission and uses direct process spawning without shell interpolation.
- Patch review is non-mutating by default; `--apply` is separate and requires file-write permission.
- Sessions are opt-in, versioned JSONL with common credential forms redacted before writing.
- Kiro tool trust remains opt-in with `--trust-all`.
- The bounded loop never executes model-generated commands.
- Release manifests include SHA-256 provenance. Cryptographic signatures require an external user-controlled signing key and are never fabricated.

Prefer scoped, short-lived provider keys and provider-side spending limits. Report vulnerabilities privately before public disclosure.
