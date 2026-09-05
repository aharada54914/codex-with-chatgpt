# V2 Beta Compatibility Matrix

Version: `2.0.0-beta.1`

| Boundary | Supported beta contract | Failure behavior |
| --- | --- | --- |
| ChatGPT | Secure MCP capable account/workspace; availability must be confirmed in the target environment | `UNAVAILABLE`; no alternate caller is selected |
| Secure MCP Tunnel | Configured official client reporting a compatible `2.x` version and passing readiness | `UNAVAILABLE` when absent; `FAIL` when present but unconfigured/incompatible |
| Codex App Server | Exactly `0.147.0` for full-control | Dispatch is rejected before startup for absent, unparseable, or other versions |
| Node.js | `>=20` | Installation/runtime is unsupported |
| State | SQLite via `better-sqlite3 11.10.0`; schema migration 7 | Startup or integrity failure is surfaced; no in-memory fallback |
| Compatibility transport | Explicit `legacy-cloudflare` selection only | Never selected automatically by the beta gate |

The read-only profile requires ChatGPT and Secure MCP but does not require App Server execution. It grants exactly `git.read`, `workspace.read`, and `workspace.search`. The full-control profile requires all three boundaries and grants exactly `approval.write`, `git.read`, `task.read`, `task.write`, `workspace.read`, and `workspace.search`. Extra scopes fail the profile rather than being ignored.

Versions not listed here are untested, not implicitly compatible.
