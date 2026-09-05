import { randomBytes } from "node:crypto";

import type { Evidence } from "../domain/types.js";
import type { DomainRepositories } from "../state/repository.js";
import type { WorkflowCheckpoints } from "../recovery/checkpoints.js";

export interface VerificationCheck { name: string; command: string; required: boolean }
export interface CheckResult {
  name: string; command: string; required: boolean; exitCode: number | null;
  status: "PASSED" | "FAILED"; startedAt: string; endedAt: string; durationMs: number;
  outputReference: string | null;
}
export interface VerificationEvidence extends Evidence { checks: CheckResult[] }

export interface VerificationExecutor {
  repositoryRevision(projectId: string): string;
  execute(input: { projectId: string; command: string }): Promise<{ exitCode: number | null; outputReference?: string }>;
}

export class VerificationError extends Error {
  constructor(public readonly code: "UNKNOWN_ACTIVITY" | "PROJECT_MISMATCH" | "STALE_REVISION" | "STALE_REPOSITORY" | "MISSING_EVIDENCE" | "CHECKS_FAILED", message: string) {
    super(message); this.name = "VerificationError";
  }
}

const KNOWN_SCRIPTS = ["typecheck", "test", "build", "lint"] as const;

export function detectVerificationChecks(input: {
  configured?: VerificationCheck[];
  packageScripts?: Record<string, string>;
  packageManager?: "npm" | "pnpm" | "yarn";
}): VerificationCheck[] {
  if (input.configured !== undefined) return input.configured.map(validateCheck);
  const manager = input.packageManager ?? "npm";
  return KNOWN_SCRIPTS.filter((name) => typeof input.packageScripts?.[name] === "string")
    .map((name) => ({ name, command: `${manager} run ${name}`, required: true }));
}

function validateCheck(check: VerificationCheck): VerificationCheck {
  const name = check.name.trim(); const command = check.command.trim();
  if (!name || name.length > 128 || !command || command.length > 4096 || command.includes("\0")) {
    throw new Error("Invalid verification check configuration");
  }
  return { name, command, required: check.required };
}

function safeOutputReference(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
}

export class VerificationService {
  constructor(
    private readonly repositories: DomainRepositories,
    private readonly executor: VerificationExecutor,
    private readonly checkpoints: WorkflowCheckpoints = { checkpoint: () => undefined },
  ) {}

  async run(input: { projectId: string; activityId: string; expectedRevision: number; checks: VerificationCheck[] }): Promise<VerificationEvidence> {
    const initial = this.requireActivity(input.projectId, input.activityId);
    if (initial.revision !== input.expectedRevision) throw new VerificationError("STALE_REVISION", "Activity revision changed");
    const repositoryRevision = this.executor.repositoryRevision(input.projectId);
    const checks = input.checks.map(validateCheck);
    if (checks.length === 0) throw new VerificationError("MISSING_EVIDENCE", "At least one verification check is required");
    const results: CheckResult[] = [];
    for (const candidate of checks) {
      const started = Date.now(); const startedAt = new Date(started).toISOString();
      let execution: { exitCode: number | null; outputReference?: string };
      try {
        execution = await this.executor.execute({ projectId: input.projectId, command: candidate.command });
      } catch {
        execution = { exitCode: null };
      }
      const ended = Date.now();
      results.push({ ...candidate, exitCode: execution.exitCode, status: execution.exitCode === 0 ? "PASSED" : "FAILED",
        startedAt, endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started),
        outputReference: safeOutputReference(execution.outputReference) });
    }
    if (this.executor.repositoryRevision(input.projectId) !== repositoryRevision) {
      throw new VerificationError("STALE_REPOSITORY", "Repository changed while checks were running");
    }
    const now = new Date().toISOString();
    const draft: VerificationEvidence = {
      id: `ev_${randomBytes(16).toString("hex")}`, projectId: input.projectId, activityId: input.activityId,
      activityRevision: -1, revision: 0, createdAt: now, updatedAt: now, kind: "verification",
      repositoryRevision, status: results.some((item) => item.required && item.status === "FAILED") ? "FAILED" : "PASSED",
      checks: results,
    };
    return this.repositories.transaction(() => {
      const current = this.requireActivity(input.projectId, input.activityId);
      if (current.revision !== input.expectedRevision) throw new VerificationError("STALE_REVISION", "Activity revision changed");
      this.repositories.evidence.insert(draft);
      this.checkpoints.checkpoint("evidence_write");
      return this.repositories.evidence.get(draft.id) as VerificationEvidence;
    });
  }

  assertAcceptable(input: { projectId: string; activityId: string; repositoryRevision: string }): VerificationEvidence {
    const activity = this.requireActivity(input.projectId, input.activityId);
    const currentRepositoryRevision = this.executor.repositoryRevision(input.projectId);
    const evidence = this.repositories.evidence.listByProject(input.projectId)
      .filter((item) => item.activityId === input.activityId && item.kind === "verification")
      .sort((left, right) => right.activityRevision - left.activityRevision)[0] as VerificationEvidence | undefined;
    if (!evidence || evidence.activityRevision !== activity.revision
      || evidence.repositoryRevision !== input.repositoryRevision
      || evidence.repositoryRevision !== currentRepositoryRevision) {
      throw new VerificationError("MISSING_EVIDENCE", "Fresh verification evidence is required");
    }
    if (evidence.status !== "PASSED" || evidence.checks.some((item) => item.required && item.status !== "PASSED")) {
      throw new VerificationError("CHECKS_FAILED", "Required verification checks failed");
    }
    return evidence;
  }

  private requireActivity(projectId: string, activityId: string) {
    const activity = this.repositories.activities.get(activityId);
    if (!activity) throw new VerificationError("UNKNOWN_ACTIVITY", "Unknown activity");
    if (activity.projectId !== projectId) throw new VerificationError("PROJECT_MISMATCH", "Activity does not belong to project");
    return activity;
  }
}
