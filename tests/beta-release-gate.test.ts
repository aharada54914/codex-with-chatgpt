import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { APP_SERVER_VERSION } from "../src/app-server/version.js";
import { runReleaseGateCli, type ReleaseGateCliDependencies } from "../src/release/cli.js";
import {
  BETA_PROFILE_SCOPES,
  publicKeySha256,
  verifySignedBetaEvidence,
  type BetaE2eEvidence,
  type SignedEvidenceEnvelope,
} from "../src/release/evidence.js";
import { BetaReleaseGateError, evaluateBetaGate, requireBetaGate } from "../src/release/gate.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const NOW = new Date("2026-09-05T12:00:00.000Z");

function envelope(overrides: Partial<BetaE2eEvidence> = {}): SignedEvidenceEnvelope {
  const evidence: BetaE2eEvidence = {
    schemaVersion: 1,
    profile: "full-control",
    environmentId: "staging-1",
    observedAt: NOW.toISOString(),
    result: "PASS",
    chatgptAvailable: true,
    transport: "secure-mcp",
    secureMcpConfigured: true,
    secureMcpReady: true,
    fallbackUsed: false,
    scopes: [...BETA_PROFILE_SCOPES["full-control"]],
    secureMcpVersion: "2.0.0",
    appServerVersion: APP_SERVER_VERSION,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(evidence));
  return { payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64") };
}

function environment(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "staging-1",
    now: NOW,
    chatgptAvailable: true,
    grantedScopes: [...BETA_PROFILE_SCOPES["full-control"]],
    secureMcp: { available: true, configured: true, compatible: true, ready: true, version: "2.0.0" },
    appServer: { available: true, version: APP_SERVER_VERSION },
    evidence: verifySignedBetaEvidence(envelope(), publicKey),
    ...overrides,
  };
}

describe("beta release profiles", () => {
  it("passes full-control only when exact scopes and signed evidence match the environment", () => {
    expect(requireBetaGate("full-control", environment())).toMatchObject({
      status: "PASS", releaseReady: true, fallbackUsed: false,
    });
  });

  it("passes read-only without App Server when its exact profile is signed", () => {
    const evidence = verifySignedBetaEvidence(envelope({
      profile: "read-only",
      scopes: [...BETA_PROFILE_SCOPES["read-only"]],
      appServerVersion: null,
    }), publicKey);
    const result = requireBetaGate("read-only", environment({
      grantedScopes: [...BETA_PROFILE_SCOPES["read-only"]],
      appServer: { available: false, version: null },
      evidence,
    }));
    expect(result.checks.map((check) => check.name)).toEqual(["chatgpt", "scopes", "secure-mcp", "profile-e2e"]);
  });

  it("fails extra scopes and evidence for another profile", () => {
    const extraScopes = evaluateBetaGate("read-only", environment({
      grantedScopes: [...BETA_PROFILE_SCOPES["read-only"], "task.write"],
    }));
    expect(extraScopes.checks.find((check) => check.name === "scopes")?.status).toBe("FAIL");

    const wrongProfile = evaluateBetaGate("read-only", environment({
      grantedScopes: [...BETA_PROFILE_SCOPES["read-only"]],
    }));
    expect(wrongProfile.checks.find((check) => check.name === "profile-e2e")?.status).toBe("FAIL");
  });

  it("rejects forged, stale, and environment-mismatched evidence", () => {
    const forged = envelope();
    forged.signature = Buffer.alloc(64).toString("base64");
    expect(() => verifySignedBetaEvidence(forged, publicKey)).toThrow("signature is invalid");

    const stale = verifySignedBetaEvidence(envelope({ observedAt: "2026-09-04T11:59:59.000Z" }), publicKey);
    expect(evaluateBetaGate("full-control", environment({ evidence: stale })).status).toBe("FAIL");

    const otherEnvironment = verifySignedBetaEvidence(envelope({ environmentId: "production" }), publicKey);
    expect(evaluateBetaGate("full-control", environment({ evidence: otherEnvironment })).status).toBe("FAIL");
  });

  it("reports unavailable prerequisites without claiming that fallback was checked", () => {
    const result = evaluateBetaGate("full-control", environment({
      chatgptAvailable: false,
      secureMcp: { available: false, configured: null, compatible: null, ready: null, version: null },
      appServer: { available: false, version: null },
      evidence: null,
    }));
    expect(result).toMatchObject({ status: "UNAVAILABLE", releaseReady: false, fallbackUsed: null });
    expect(() => requireBetaGate("full-control", { ...environment(), evidence: null })).toThrow(BetaReleaseGateError);
  });

  it("fails version drift against signed evidence", () => {
    const result = evaluateBetaGate("full-control", environment({
      appServer: { available: true, version: "0.148.0" },
    }));
    expect(result.status).toBe("FAIL");
    expect(result.checks.find((check) => check.name === "app-server")?.status).toBe("FAIL");

    const unsupportedTunnel = verifySignedBetaEvidence(envelope({ secureMcpVersion: "1.9.0" }), publicKey);
    expect(evaluateBetaGate("full-control", environment({
      secureMcp: { available: true, configured: true, compatible: true, ready: true, version: "1.9.0" },
      evidence: unsupportedTunnel,
    })).status).toBe("FAIL");
  });
});

describe("release gate CLI", () => {
  function dependencies(output: string[], error: string[]): ReleaseGateCliDependencies {
    const signed = JSON.stringify(envelope());
    return {
      readFile: (path) => path === "evidence.json" ? signed : publicKey,
      trustedKeySha256: () => publicKeySha256(publicKey),
      probeAppServer: () => ({ available: true, version: APP_SERVER_VERSION }),
      probeSecureMcp: async () => ({
        ok: true,
        binaryFound: true,
        commandConfigured: true,
        compatible: true,
        version: "2.0.0",
        errors: [],
      }),
      now: () => NOW,
      stdout: (value) => output.push(value),
      stderr: (value) => error.push(value),
    };
  }

  it("returns process-friendly PASS, FAIL, and UNAVAILABLE exit statuses", async () => {
    const output: string[] = [];
    const error: string[] = [];
    expect(await runReleaseGateCli([
      "--profile", "full-control", "--environment", "staging-1",
      "--evidence", "evidence.json", "--public-key", "public.pem",
    ], dependencies(output, error))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "PASS", fallbackUsed: false });

    expect(await runReleaseGateCli([
      "--profile", "read-only", "--environment", "staging-1",
      "--evidence", "evidence.json", "--public-key", "public.pem",
    ], dependencies([], error))).toBe(1);

    expect(await runReleaseGateCli([
      "--profile", "full-control", "--environment", "staging-1",
    ], dependencies([], error))).toBe(2);
    expect(error).toEqual([]);
  });

  it("rejects an otherwise valid envelope signed by a key outside the trust anchor", async () => {
    const output: string[] = [];
    const error: string[] = [];
    const deps = dependencies(output, error);
    deps.trustedKeySha256 = () => "00".repeat(32);
    expect(await runReleaseGateCli([
      "--profile", "full-control", "--environment", "staging-1",
      "--evidence", "evidence.json", "--public-key", "public.pem",
    ], deps)).toBe(1);
    expect(error).toEqual(["beta evidence public key is not trusted"]);
  });

  it("classifies App Server incompatibility as FAIL and absence as UNAVAILABLE", async () => {
    const incompatible = dependencies([], []);
    incompatible.probeAppServer = () => ({ available: true, version: "0.148.0" });
    expect(await runReleaseGateCli([
      "--profile", "full-control", "--environment", "staging-1",
      "--evidence", "evidence.json", "--public-key", "public.pem",
    ], incompatible)).toBe(1);

    const unavailable = dependencies([], []);
    unavailable.probeAppServer = () => ({ available: false, version: null });
    expect(await runReleaseGateCli([
      "--profile", "full-control", "--environment", "staging-1",
      "--evidence", "evidence.json", "--public-key", "public.pem",
    ], unavailable)).toBe(2);
  });

  it("requires the authoritative Secure MCP doctor to pass", async () => {
    const deps = dependencies([], []);
    deps.probeSecureMcp = async () => ({
      ok: false,
      binaryFound: true,
      commandConfigured: true,
      compatible: true,
      version: "2.0.0",
      errors: [{ code: "doctor_failed", message: "readiness failed" }],
    });
    expect(await runReleaseGateCli([
      "--profile", "full-control", "--environment", "staging-1",
      "--evidence", "evidence.json", "--public-key", "public.pem",
    ], deps)).toBe(1);
  });
});
