# Beta Release Gate Record

Target: `2.0.0-beta.1`

## Deterministic local gates

The release candidate must pass:

- full unit/integration suite
- `test:beta` security, recovery, protocol, transport, policy, and local profile contracts
- build and typecheck
- generated App Server protocol drift check
- `git diff --check`

## External E2E profiles

Local probe on 2026-09-05: Codex CLI/App Server version `0.147.0` is available and compatible; `tunnel-client` is not installed, so no external profile was run. ChatGPT entitlement was not inferred from the local process.

| Profile | Required external path | Current record |
| --- | --- | --- |
| read-only | ChatGPT → Secure MCP → bounded V2 data plane | `UNAVAILABLE` until executed in an entitled target environment |
| full-control | ChatGPT → Secure MCP → orchestrator → Codex App Server `0.147.0` | `UNAVAILABLE` until executed in an entitled target environment |

`UNAVAILABLE` is intentionally not converted to PASS. Before publishing beyond beta, an operator must run each available profile, attach sanitized evidence, and update this record with environment, versions, timestamp, and result. Compatibility transport results cannot substitute for either profile.

## Machine-enforced evidence contract

Run `npm run release:gate -- --profile <read-only|full-control> --environment <id> --evidence <envelope.json> --public-key <ed25519-public-key.pem>` with the independently provisioned `C2C_RELEASE_EVIDENCE_KEY_SHA256` trust anchor and the Secure MCP doctor options described in the operations runbook. A trusted external harness signs an envelope containing the profile, environment ID, observation timestamp, result, ChatGPT availability, exact granted scopes, Secure MCP transport/configuration/readiness/version, App Server version, and `fallbackUsed: false`.

The gate rejects invalid signatures, keys outside the protected trust anchor, evidence older than 24 hours, timestamps more than five minutes in the future, environment/profile/version drift, missing or extra scopes, any non-Secure-MCP transport, failed provider doctor/readiness, and any fallback claim. Evidence absence remains `UNAVAILABLE`; an arbitrary evidence reference, a self-authored local string, or a self-signed key cannot produce PASS.

Required exact scopes are:

- read-only: `git.read`, `workspace.read`, `workspace.search`
- full-control: `approval.write`, `git.read`, `task.read`, `task.write`, `workspace.read`, `workspace.search`
