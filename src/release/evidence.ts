import { createHash, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";

export const BETA_PROFILE_SCOPES = {
  "read-only": ["git.read", "workspace.read", "workspace.search"],
  "full-control": [
    "approval.write",
    "git.read",
    "task.read",
    "task.write",
    "workspace.read",
    "workspace.search",
  ],
} as const;

export const betaProfileSchema = z.enum(["read-only", "full-control"]);
export type BetaProfile = z.infer<typeof betaProfileSchema>;

export const betaEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  profile: betaProfileSchema,
  environmentId: z.string().min(1).max(256),
  observedAt: z.string().datetime(),
  result: z.enum(["PASS", "FAIL"]),
  chatgptAvailable: z.boolean(),
  transport: z.literal("secure-mcp"),
  secureMcpConfigured: z.boolean(),
  secureMcpReady: z.boolean(),
  fallbackUsed: z.literal(false),
  scopes: z.array(z.string().min(1)).max(32),
  secureMcpVersion: z.string().min(1),
  appServerVersion: z.string().min(1).nullable(),
}).strict();

export type BetaE2eEvidence = z.infer<typeof betaEvidenceSchema>;

const signedEvidenceEnvelopeSchema = z.object({
  payload: z.string().min(1),
  signature: z.string().min(1),
}).strict();

export type SignedEvidenceEnvelope = z.infer<typeof signedEvidenceEnvelopeSchema>;

const verifiedEvidence = new WeakSet<object>();

export interface VerifiedBetaEvidence {
  readonly evidence: BetaE2eEvidence;
}

export function publicKeySha256(publicKey: string | Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function assertTrustedPublicKey(publicKey: string | Buffer, expectedSha256: string): void {
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) throw new Error("trusted evidence key SHA-256 is invalid");
  const actual = Buffer.from(publicKeySha256(publicKey), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  if (!timingSafeEqual(actual, expected)) throw new Error("beta evidence public key is not trusted");
}

function decodeBase64(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${field} must be canonical base64`);
  }
  return Buffer.from(value, "base64");
}

export function verifySignedBetaEvidence(
  input: unknown,
  publicKey: string | Buffer,
): VerifiedBetaEvidence {
  const envelope = signedEvidenceEnvelopeSchema.parse(input);
  const payload = decodeBase64(envelope.payload, "payload");
  const signature = decodeBase64(envelope.signature, "signature");
  if (!verify(null, payload, publicKey, signature)) {
    throw new Error("beta evidence signature is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("beta evidence payload is not valid JSON");
  }

  const value = Object.freeze({ evidence: Object.freeze(betaEvidenceSchema.parse(decoded)) });
  verifiedEvidence.add(value);
  return value;
}

export function unwrapVerifiedBetaEvidence(value: VerifiedBetaEvidence): BetaE2eEvidence | null {
  return verifiedEvidence.has(value) ? value.evidence : null;
}
