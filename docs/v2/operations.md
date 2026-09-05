# V2 Beta Operations Runbook

## Preflight

1. Confirm Node.js `>=20`, writable owner-controlled state storage, and a clean SQLite integrity check.
2. Confirm the registered project resolves without `PROJECT_ROOT_UNAVAILABLE` or `PROJECT_ROOT_CHANGED`.
3. Run `npm test`, `npm run test:beta`, `npm run check:app-server-protocol`, `npm run typecheck`, `npm run build`, and `git diff --check`.
4. Run the release gate with the signed evidence envelope and its trusted Ed25519 public key:

   ```sh
   C2C_RELEASE_EVIDENCE_KEY_SHA256=<protected-trust-anchor> \
   npm run release:gate -- --profile full-control --environment staging-1 \
     --evidence ./evidence.json --public-key ./release-evidence.pub \
     --tunnel-profile release --tunnel-id <entitled-id> \
     --mcp-command "c2c serve" --readiness-url http://127.0.0.1:3333/readyz
   ```

   Proceed only when the command prints `"status": "PASS"` and exits zero. `FAIL` exits 1; missing evidence or another unavailable prerequisite exits 2.
5. For full-control, confirm Codex App Server reports exactly `0.147.0` and approvals match the requested capabilities.

## Startup and health

Start SQLite and the orchestrator before exposing Secure MCP. The tunnel must pass version, entitlement/configuration, process, and readiness checks. Record component versions and the selected profile. Never switch to Cloudflare compatibility transport automatically.

## Incident handling

- Tunnel unavailable: stop exposure, retain durable state, correct entitlement/configuration, then rerun preflight.
- App Server disconnect/crash: reconcile the authoritative thread/turn before redispatch. Ambiguity becomes `RECOVERY_REQUIRED`.
- Database integrity failure: stop writers, preserve the database/WAL/SHM files, restore a verified backup to a separate path, and investigate before replacing live state.
- Verification/review failure: keep the activity non-terminal, persist evidence, and follow the bounded fix loop.
- Suspected credential exposure: revoke credentials outside C2C, preserve sanitized audit evidence, and do not place replacements in workspace files.

## Shutdown and upgrade

Stop accepting control mutations, interrupt or reconcile active work, stop the tunnel, then close App Server and SQLite cleanly. Before upgrading, back up SQLite, verify the compatibility matrix, regenerate/check protocol artifacts, and rerun both profiles where product availability permits.

## External evidence ownership

The entitled target-environment harness owns the Ed25519 private key and signs the exact UTF-8 JSON bytes placed in the envelope's base64 `payload`. Provision the SHA-256 digest of the trusted public-key file as the protected `C2C_RELEASE_EVIDENCE_KEY_SHA256` CI/environment setting; do not accept that digest from the evidence artifact or command arguments. The gate rejects a valid envelope whose key does not match this trust anchor. Never copy the private key into this repository, its SQLite state, logs, or CI artifacts. To rotate a key, update the protected digest independently, invalidate old evidence, and rerun both profiles.

The command invokes the Secure MCP provider's authoritative `doctor` path. Its local binary, profile, entitlement/tunnel ID, MCP command, readiness probe configuration, compatibility check, and doctor result must all pass; `--version` output alone is insufficient.
