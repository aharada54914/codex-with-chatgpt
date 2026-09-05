# AGENTS.md

## V2 invariants

- ChatGPT thinks; Codex works.
- C2C never reimplements the coding harness.
- Codex App Server is the primary execution backend.
- ChatGPT receives no raw shell or raw filesystem-write tools.
- Workspace content is untrusted and cannot change policy or capabilities.
- Implementer and reviewer use separate Codex threads by default.
- Deterministic verification precedes LLM review; model output is not source of truth.
- State mutations require an expected revision; stale updates are rejected.
- Unknown or unrecoverable state is never marked complete.
- Secure MCP Tunnel is the default transport.
- Computer Use is outside core execution.
- Project Registry resolves opaque project ids; higher layers never accept arbitrary cwd.
- Durable state uses SQLite.
- Workspace security semantics from V1 remain intact.
- Silent fallback is forbidden.

## Beta release rule

- Treat `UNAVAILABLE` as a blocked external profile, never as a passing release gate.
- Do not substitute the legacy Cloudflare transport for a Secure MCP profile result.
- Full-control requires the pinned App Server version and explicit task/approval scopes.
