# Architecture

Ultron separates terminal/UI, stateful conversation orchestration, provider adapters, project intelligence, tool transports, workspace connectors, process adapters, and bounded execution.

## Interactive conversation boundary

The chat layer owns structured user/assistant history, context bounds, project attachments, slash commands, redacted persistence, and resume. Direct API adapters receive structured messages. External CLI adapters receive a delimited bounded transcript, without pretending to use undocumented vendor session APIs.

Context sources are explicit and read-only: `/index`, `/git`, and `/add`. Attachments must be project-local text files and are byte bounded. Context compaction removes oldest messages deterministically while retaining current work and reports the omitted count through `/context`.

## Trust boundaries

1. **User shell** owns credentials and local files.
2. **Permission profiles** gate file writes, shell/MCP launch, web, and Notion access. The default is `read-only`.
3. **Provider adapters** send explicit prompts and bounded chat context; direct adapters support streaming, cancellation, retries, capability discovery, and usage metadata.
4. **External CLI adapters** invoke installed binaries without shell interpolation.
5. **Interactive chat** never executes model-generated commands. `Ctrl+C` cancels supported direct requests without ending the session.
6. **MCP client** launches only an explicit executable under a shell-enabled profile.
7. **Project indexer** follows `.gitignore` and `.ultronignore`, skips symlinks, and applies file/byte limits.
8. **Patch review** uses `git apply --check`; application is separate and requires write permission.
9. **Session store** is opt-in, redacted, versioned JSONL with restrictive POSIX file permissions where supported.
10. **Agentic loop** remains capped at three passes.

## Provider extension contract

A provider implements `description`, `configured()`, and `ask(prompt, options)`. Direct providers may implement `askDetailed()`, `listModels()`, and a `capabilities` object. Chat history is supplied as `options.messages`.
