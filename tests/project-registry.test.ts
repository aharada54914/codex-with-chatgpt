import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectRegistry, ProjectRegistryError } from "../src/projects/registry.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function setup(): { registry: ProjectRegistry; close: () => void } {
  const state = makeTmpDir("c2c-project-registry-state");
  directories.push(state);
  const database = openStateDatabase(path.join(state, "state.sqlite3"));
  return { registry: new ProjectRegistry(new DomainRepositories(database)), close: () => database.close() };
}

describe("ProjectRegistry", () => {
  it("registers a canonical root and exposes only an opaque project summary", () => {
    const root = makeTmpDir("c2c-project"); directories.push(root);
    write(root, "README.md", "hello\n");
    const { registry, close } = setup();
    const project = registry.registerLocal(root, { name: "Example" });

    expect(project).toEqual({ projectId: expect.stringMatching(/^prj_[a-f0-9]{32}$/), name: "Example" });
    expect(JSON.stringify(project)).not.toContain(root);
    expect(registry.get(project.projectId)).toEqual(project);
    expect(registry.resolvePath(project.projectId, "README.md").rel).toBe("README.md");
    close();
  });

  it("rejects duplicate canonical roots, including a symlink alias", () => {
    const root = makeTmpDir("c2c-project-duplicate"); directories.push(root);
    const aliasParent = makeTmpDir("c2c-project-alias"); directories.push(aliasParent);
    const alias = path.join(aliasParent, "alias");
    try { fs.symlinkSync(root, alias, "dir"); } catch { return; }
    const { registry, close } = setup();
    registry.registerLocal(root);
    expect(() => registry.registerLocal(alias)).toThrowError(ProjectRegistryError);
    expect(() => registry.registerLocal(alias)).toThrow(/already registered/i);
    close();
  });

  it("rejects unknown projects and roots moved after registration", () => {
    const root = makeTmpDir("c2c-project-moved"); directories.push(root);
    const moved = `${root}-renamed`; directories.push(moved);
    const { registry, close } = setup();
    const project = registry.registerLocal(root);
    expect(() => registry.get("prj_00000000000000000000000000000000")).toThrow(/unknown project/i);
    fs.renameSync(root, moved);
    expect(() => registry.resolveWorkspace(project.projectId)).toThrow(/no longer available|moved/i);
    close();
  });

  it("rejects a different directory substituted at the same path", () => {
    const root = makeTmpDir("c2c-project-replaced"); directories.push(root);
    const original = `${root}-original`; directories.push(original);
    const { registry, close } = setup();
    const project = registry.registerLocal(root);
    fs.renameSync(root, original);
    fs.mkdirSync(root);

    expect(() => registry.resolveWorkspace(project.projectId)).toThrow(/identity/i);
    close();
  });

  it("preserves traversal and symlink containment for registered projects", () => {
    const root = makeTmpDir("c2c-project-contained"); directories.push(root);
    const outside = makeTmpDir("c2c-project-outside"); directories.push(outside);
    write(outside, "secret.txt", "secret\n");
    const { registry, close } = setup();
    const project = registry.registerLocal(root);
    expect(() => registry.resolvePath(project.projectId, "../secret.txt")).toThrow(/outside/i);
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape"));
      expect(() => registry.resolvePath(project.projectId, "escape")).toThrow(/outside/i);
    } catch (error) {
      if (!(error instanceof ProjectRegistryError) && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    close();
  });

  it("prevents paths from crossing between registered projects", () => {
    const first = makeTmpDir("c2c-project-first"); directories.push(first);
    const second = makeTmpDir("c2c-project-second"); directories.push(second);
    write(second, "private.txt", "private\n");
    const { registry, close } = setup();
    const firstProject = registry.registerLocal(first);
    const secondProject = registry.registerLocal(second);

    expect(() => registry.resolvePath(firstProject.projectId, path.join(second, "private.txt"))).toThrow(/outside/i);
    expect(registry.resolvePath(secondProject.projectId, "private.txt").rel).toBe("private.txt");
    close();
  });

  it("does not accept a cwd on its higher-layer resolution API", () => {
    expect(ProjectRegistry.prototype.resolveWorkspace.length).toBe(1);
    expect(ProjectRegistry.prototype.resolvePath.length).toBe(2);
  });
});
