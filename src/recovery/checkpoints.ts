export const CRASH_BOUNDARIES = ["dispatch", "execution", "evidence_write", "review", "transition"] as const;
export type CrashBoundary = typeof CRASH_BOUNDARIES[number];
export interface WorkflowCheckpoints { checkpoint(boundary: CrashBoundary): void }

export class InjectedCrash extends Error {
  constructor(public readonly boundary: CrashBoundary) { super(`Injected crash at ${boundary}`); this.name = "InjectedCrash"; }
}

export class CrashInjector implements WorkflowCheckpoints {
  constructor(private readonly target?: CrashBoundary) {}
  checkpoint(boundary: CrashBoundary): void { if (boundary === this.target) throw new InjectedCrash(boundary); }
}
