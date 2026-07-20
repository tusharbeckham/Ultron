# Architecture

Ultron separates terminal/UI, provider adapters, project intelligence, tool transports, workspace connectors, process adapters, and bounded orchestration.

## Trust boundaries

1. **User shell** owns credentials and local files.
2. **Permission profiles** gate file writes, shell/MCP launch, web, and Notion access. The default is `read-only`.
3. **Provider adapters** send only explicit prompts and expose streaming, cancellation, retries, capability discovery, and usage metadata.
4. **External CLI adapters** invoke installed binaries without shell interpolation.
5. **MCP client** launches only an explicit executable under a shell-enabled profile and uses JSON-RPC over stdio.
6. **Project indexer** follows `.gitignore` and `.ultronignore`, skips symlinks, and applies file/byte limits.
7. **Patch review** uses `git apply --check`; application is separate and requires write permission.
8. **Session store** is opt-in, redacted, versioned JSONL with restrictive file permissions.
9. **Agent transport** is stable newline-delimited JSON-RPC (`ultron-jsonl/1`) for editor integration.
10. **Agentic loop** remains capped at three passes and never executes generated shell commands.

## Provider extension contract

A provider implements `description`, `configured()`, and `ask(prompt, options)`. Direct providers may implement `askDetailed()`, `listModels()`, and a `capabilities` object. Optional `available()` checks a local executable.

## Verification loop

Release work uses at most three local passes: implement → test/package checks → targeted repair. Live provider calls are a separate credential-gated smoke-test stage.
