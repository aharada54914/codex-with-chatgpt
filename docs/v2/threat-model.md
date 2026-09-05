# V2 Threat Model

## Assets and trust boundaries

Protected assets are workspace contents, credentials, approval authority, durable activity history, verification evidence, and repository/deployment side effects. ChatGPT, Secure MCP, the orchestrator, Codex App Server, SQLite, and each registered workspace are separate boundaries. Workspace files, diffs, generated text, and model output are untrusted data.

## Principal threats and controls

| Threat | Required control |
| --- | --- |
| Prompt injection widens capability | Policy derives grants only from trusted configuration and scoped approvals |
| Arbitrary filesystem access | Remote schemas accept opaque `project_id`, never cwd; Project Registry revalidates realpath and filesystem identity |
| Raw execution exposure | MCP exposes bounded reads and high-level task controls, not shell/write/unrestricted git tools |
| Stale or replayed mutation | Every mutation binds expected revision and idempotency key |
| Forged completion | Deterministic evidence precedes independent review; unresolved recovery becomes `RECOVERY_REQUIRED` |
| Duplicate side effect after crash | Durable job side-effect keys and reconciliation precede redispatch |
| Cross-project approval | Approval, activity, actor, scope, expiry, and revision are checked together |
| Secret leakage | Sensitive workspace paths are denied and persisted output is sanitized and bounded |
| Downgrade/fallback attack | Unsupported transport, App Server, state, or entitlement remains an explicit failure |
| Migration data loss | Regular-file validation, identity binding, pre-import backup, unique batches, drift detection, and rollback |

## Residual risk

The beta does not prove the security of ChatGPT, the official tunnel service, Codex itself, the host OS, or third-party compatibility infrastructure. A compromised local privileged administrator can alter configuration and state. Production deployment and secret use remain separately approved capabilities.
