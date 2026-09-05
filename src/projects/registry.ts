import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";

import type { Project } from "../domain/types.js";
import type { DomainRepositories } from "../state/repository.js";
import { Workspace } from "../workspace/manager.js";

export type ProjectRegistryErrorCode =
  | "UNKNOWN_PROJECT"
  | "DUPLICATE_ROOT"
  | "PROJECT_ROOT_UNAVAILABLE"
  | "PROJECT_ROOT_CHANGED";

export class ProjectRegistryError extends Error {
  constructor(public readonly code: ProjectRegistryErrorCode, message: string) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

export interface ProjectSummary {
  projectId: string;
  name: string;
}

function filesystemIdentity(root: string): string {
  const stat = fs.statSync(root, { bigint: true });
  // dev + ino map to the filesystem object (including Windows file IDs in Node),
  // while birthtime provides a replacement discriminator on filesystems that
  // report zero/incomplete inode data. Hashing keeps host metadata private.
  return createHash("sha256")
    .update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`)
    .digest("hex");
}

/**
 * Local privileged project administration and opaque-id workspace resolution.
 * Registration is deliberately absent from all remote control-plane schemas.
 */
export class ProjectRegistry {
  constructor(private readonly repositories: DomainRepositories) {}

  registerLocal(root: string, options: { name?: string } = {}): ProjectSummary {
    const workspace = new Workspace(root);
    const now = new Date().toISOString();
    const record: Project = {
      id: `prj_${randomBytes(16).toString("hex")}`,
      projectId: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      name: options.name?.trim() || workspace.name,
      canonicalRoot: workspace.root,
      rootFingerprint: workspace.id,
      filesystemIdentity: filesystemIdentity(workspace.root),
    };

    try {
      this.repositories.projects.insert(record);
    } catch (error) {
      if (error instanceof Error && /unique constraint/i.test(error.message)) {
        throw new ProjectRegistryError("DUPLICATE_ROOT", "This canonical workspace root is already registered");
      }
      throw error;
    }
    return this.toSummary(record);
  }

  get(projectId: string): ProjectSummary {
    return this.toSummary(this.requireRecord(projectId));
  }

  list(): ProjectSummary[] {
    return this.repositories.projects.listByProject(null).map((project) => this.toSummary(project));
  }

  resolveWorkspace(projectId: string): Workspace {
    const project = this.requireRecord(projectId);
    let workspace: Workspace;
    try {
      workspace = new Workspace(project.canonicalRoot);
    } catch {
      throw new ProjectRegistryError(
        "PROJECT_ROOT_UNAVAILABLE",
        `The registered root for project '${projectId}' is no longer available or was moved`,
      );
    }
    if (
      workspace.root !== project.canonicalRoot
      || workspace.id !== project.rootFingerprint
      || filesystemIdentity(workspace.root) !== project.filesystemIdentity
    ) {
      throw new ProjectRegistryError(
        "PROJECT_ROOT_CHANGED",
        `The registered root for project '${projectId}' no longer has its registered identity`,
      );
    }
    return workspace;
  }

  resolvePath(projectId: string, relativePath: string): ReturnType<Workspace["resolve"]> {
    return this.resolveWorkspace(projectId).resolve(relativePath);
  }

  private requireRecord(projectId: string): Project {
    const project = this.repositories.projects.get(projectId);
    if (!project) throw new ProjectRegistryError("UNKNOWN_PROJECT", `Unknown project_id: ${projectId}`);
    return project;
  }

  private toSummary(project: Project): ProjectSummary {
    return { projectId: project.id, name: project.name };
  }
}
