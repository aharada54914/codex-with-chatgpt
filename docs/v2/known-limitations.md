# V2 Beta Known Limitations

- Real ChatGPT and Secure MCP end-to-end execution depends on account entitlement and target-environment availability. Local tests cannot certify that external path.
- Passing release evidence must be produced and Ed25519-signed by a trusted harness in that entitled environment; this repository neither provisions the harness nor owns its private key.
- Full-control supports Codex App Server `0.147.0` only. There is no automatic version downgrade or alternate execution backend.
- The read-only profile validates the MCP data plane; it does not start Codex App Server.
- V1 execution-output bodies/references are not imported. Their source files must be retained for manual handling.
- Cloudflare, legacy OAuth/pairing, manual execution records, session state, UI preferences, and sandbox allowlist behavior remain only in explicit compatibility/local CLI adapters.
- Computer Use protocol events may be parsed as App Server data, but Computer Use is not a core execution dependency or fallback.
- Production deployment, network access, secrets, and git push remain separate approval capabilities and are not implied by “full-control.”
- Recovery can deliberately stop at `RECOVERY_REQUIRED`; operators must resolve ambiguous external state.
