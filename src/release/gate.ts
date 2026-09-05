import { checkAppServerVersion } from "../app-server/version.js";
import {
  BETA_PROFILE_SCOPES,
  unwrapVerifiedBetaEvidence,
  type BetaE2eEvidence,
  type BetaProfile,
  type VerifiedBetaEvidence,
} from "./evidence.js";

export type { BetaProfile } from "./evidence.js";
export type GateStatus = "PASS" | "FAIL" | "UNAVAILABLE";

export interface BetaEnvironment {
  environmentId: string;
  now?: Date;
  chatgptAvailable: boolean;
  grantedScopes: string[] | null;
  secureMcp: {
    available: boolean;
    configured: boolean | null;
    compatible: boolean | null;
    ready: boolean | null;
    version: string | null;
  };
  appServer: { available: boolean; version: string | null };
  evidence: VerifiedBetaEvidence | null;
}

export interface GateCheck {
  name: "chatgpt" | "scopes" | "secure-mcp" | "app-server" | "profile-e2e";
  status: GateStatus;
  detail: string;
}

export interface BetaGateResult {
  profile: BetaProfile;
  status: GateStatus;
  releaseReady: boolean;
  fallbackUsed: boolean | null;
  checks: GateCheck[];
}

const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export function isCompatibleSecureMcpVersion(version: string | null): boolean {
  return version !== null && /(?:^|\s|v)2\.\d+\.\d+(?:\s|$)/.test(version);
}

function availability(name: GateCheck["name"], available: boolean): GateCheck {
  return available
    ? { name, status: "PASS", detail: `${name} is available` }
    : { name, status: "UNAVAILABLE", detail: `${name} is unavailable` };
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every((scope) => actual.includes(scope));
}

function evidenceMatches(
  profile: BetaProfile,
  environment: BetaEnvironment,
  evidence: BetaE2eEvidence,
): string | null {
  const expectedScopes = BETA_PROFILE_SCOPES[profile];
  if (evidence.profile !== profile) return "evidence profile does not match the requested profile";
  if (evidence.environmentId !== environment.environmentId) return "evidence environment does not match";
  if (evidence.result !== "PASS") return "external profile result did not pass";
  if (!evidence.chatgptAvailable) return "ChatGPT was not available for the external profile";
  if (!environment.grantedScopes || !sameSet(evidence.scopes, expectedScopes)
    || !sameSet(evidence.scopes, environment.grantedScopes)) {
    return "evidence scopes do not exactly match the profile and granted scopes";
  }
  if (!evidence.secureMcpConfigured) return "Secure MCP was not configured in external evidence";
  if (!evidence.secureMcpReady) return "Secure MCP readiness did not pass in external evidence";
  if (!isCompatibleSecureMcpVersion(evidence.secureMcpVersion)) return "evidence reports an unsupported Secure MCP version";
  if (environment.secureMcp.available && evidence.secureMcpVersion !== environment.secureMcp.version) {
    return "Secure MCP version does not match evidence";
  }
  if (profile === "full-control" && environment.appServer.available
    && evidence.appServerVersion !== environment.appServer.version) {
    return "App Server version does not match evidence";
  }

  const age = (environment.now ?? new Date()).getTime() - Date.parse(evidence.observedAt);
  if (age > MAX_EVIDENCE_AGE_MS) return "evidence is older than 24 hours";
  if (age < -MAX_FUTURE_SKEW_MS) return "evidence timestamp is too far in the future";
  return null;
}

export function evaluateBetaGate(profile: BetaProfile, environment: BetaEnvironment): BetaGateResult {
  const expectedScopes = BETA_PROFILE_SCOPES[profile];
  const checks: GateCheck[] = [availability("chatgpt", environment.chatgptAvailable)];
  checks.push(environment.grantedScopes === null
    ? { name: "scopes", status: "UNAVAILABLE", detail: "granted scopes are unverified" }
    : sameSet(environment.grantedScopes, expectedScopes)
      ? { name: "scopes", status: "PASS", detail: `exact ${profile} scopes are granted` }
      : { name: "scopes", status: "FAIL", detail: `granted scopes must exactly match the ${profile} profile` });

  if (!environment.secureMcp.available) {
    checks.push(availability("secure-mcp", false));
  } else if (environment.secureMcp.configured === null || environment.secureMcp.compatible === null
    || environment.secureMcp.ready === null) {
    checks.push({ name: "secure-mcp", status: "UNAVAILABLE", detail: "Secure MCP configuration, compatibility, or readiness is unverified" });
  } else if (!environment.secureMcp.configured || !environment.secureMcp.compatible || !environment.secureMcp.ready
    || !isCompatibleSecureMcpVersion(environment.secureMcp.version)) {
    checks.push({ name: "secure-mcp", status: "FAIL", detail: "Secure MCP must be configured and compatible" });
  } else {
    checks.push({ name: "secure-mcp", status: "PASS", detail: "Secure MCP is configured and compatible" });
  }

  if (profile === "full-control") {
    if (!environment.appServer.available) {
      checks.push(availability("app-server", false));
    } else {
      const compatibility = checkAppServerVersion(environment.appServer.version);
      checks.push(compatibility.compatible
        ? { name: "app-server", status: "PASS", detail: `App Server ${compatibility.version} is supported` }
        : { name: "app-server", status: "FAIL", detail: compatibility.detail ?? "App Server is incompatible" });
    }
  }

  let evidence: BetaE2eEvidence | null = null;
  if (environment.evidence === null) {
    checks.push({ name: "profile-e2e", status: "UNAVAILABLE", detail: "signed external profile evidence is unavailable" });
  } else {
    evidence = unwrapVerifiedBetaEvidence(environment.evidence);
    const mismatch = evidence ? evidenceMatches(profile, environment, evidence) : "evidence is not authentically verified";
    checks.push(mismatch
      ? { name: "profile-e2e", status: "FAIL", detail: mismatch }
      : { name: "profile-e2e", status: "PASS", detail: "signed external profile evidence is valid and bound to this environment" });
  }

  const status: GateStatus = checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : checks.some((check) => check.status === "UNAVAILABLE") ? "UNAVAILABLE" : "PASS";
  return { profile, status, releaseReady: status === "PASS", fallbackUsed: evidence?.fallbackUsed ?? null, checks };
}

export class BetaReleaseGateError extends Error {
  constructor(public readonly result: BetaGateResult) {
    super(`Beta ${result.profile} profile is ${result.status.toLowerCase()}`);
    this.name = "BetaReleaseGateError";
  }
}

export function requireBetaGate(profile: BetaProfile, environment: BetaEnvironment): BetaGateResult {
  const result = evaluateBetaGate(profile, environment);
  if (!result.releaseReady) throw new BetaReleaseGateError(result);
  return result;
}
