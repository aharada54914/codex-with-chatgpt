import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { guardAppServerVersion } from "../app-server/version.js";
import { SecureMcpTunnelClient, type SecureMcpDoctorReport } from "../tunnel/secure-mcp.js";
import {
  assertTrustedPublicKey,
  betaProfileSchema,
  unwrapVerifiedBetaEvidence,
  verifySignedBetaEvidence,
} from "./evidence.js";
import { evaluateBetaGate } from "./gate.js";

export interface ReleaseGateCliDependencies {
  readFile(path: string): string;
  trustedKeySha256(): string | null;
  probeAppServer(): { available: boolean; version: string | null };
  probeSecureMcp(options: {
    profile?: string;
    tunnelId?: string;
    mcpCommand?: string;
    readinessUrl?: string;
  }): Promise<Pick<SecureMcpDoctorReport, "ok" | "binaryFound" | "commandConfigured" | "compatible" | "version" | "errors">>;
  now(): Date;
  stdout(value: string): void;
  stderr(value: string): void;
}

const defaults: ReleaseGateCliDependencies = {
  readFile: (path) => readFileSync(path, "utf8"),
  trustedKeySha256: () => process.env.C2C_RELEASE_EVIDENCE_KEY_SHA256 ?? null,
  probeAppServer: () => {
    const result = guardAppServerVersion();
    if (result.ok) return { available: true, version: result.version };
    return {
      available: result.error.code !== "version_unavailable",
      version: result.error.version,
    };
  },
  probeSecureMcp: (options) => new SecureMcpTunnelClient(options).doctor(),
  now: () => new Date(),
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
};

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument near ${key ?? "end of input"}`);
    result[key.slice(2)] = value;
  }
  return result;
}

export async function runReleaseGateCli(
  args: string[],
  dependencies: ReleaseGateCliDependencies = defaults,
): Promise<number> {
  try {
    const values = options(args);
    const profile = betaProfileSchema.parse(values.profile);
    const environmentId = values.environment;
    if (!environmentId) throw new Error("--environment is required");
    if (Boolean(values.evidence) !== Boolean(values["public-key"])) {
      throw new Error("--evidence and --public-key must be supplied together");
    }

    let verified = null;
    if (values.evidence) {
      const publicKey = dependencies.readFile(values["public-key"]!);
      const trustAnchor = dependencies.trustedKeySha256();
      if (!trustAnchor) throw new Error("C2C_RELEASE_EVIDENCE_KEY_SHA256 trust anchor is required");
      assertTrustedPublicKey(publicKey, trustAnchor);
      verified = verifySignedBetaEvidence(JSON.parse(dependencies.readFile(values.evidence)), publicKey);
    }
    const signed = verified ? unwrapVerifiedBetaEvidence(verified) : null;
    const tunnel = await dependencies.probeSecureMcp({
      profile: values["tunnel-profile"],
      tunnelId: values["tunnel-id"],
      mcpCommand: values["mcp-command"],
      readinessUrl: values["readiness-url"],
    });
    const appServer = dependencies.probeAppServer();
    const configurationErrorCodes = new Set(["entitlement_missing", "profile_not_configured", "command_not_configured", "readiness_not_configured"]);
    const configured = tunnel.binaryFound
      ? !tunnel.errors.some((error) => configurationErrorCodes.has(error.code))
      : null;
    const environment = {
      environmentId,
      now: dependencies.now(),
      chatgptAvailable: signed?.chatgptAvailable ?? false,
      grantedScopes: signed?.scopes ?? null,
      secureMcp: {
        available: tunnel.binaryFound,
        configured,
        compatible: tunnel.binaryFound ? tunnel.compatible : null,
        ready: tunnel.binaryFound ? tunnel.ok : null,
        version: tunnel.version,
      },
      appServer,
      evidence: verified,
    };
    const result = evaluateBetaGate(profile, environment);
    dependencies.stdout(JSON.stringify(result, null, 2));
    return result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function main(): Promise<void> {
  process.exitCode = await runReleaseGateCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
