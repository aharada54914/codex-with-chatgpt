import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  APP_SERVER_PROTOCOL_IMPORT_EXTENSION,
  APP_SERVER_PROTOCOL_PROVENANCE,
  APP_SERVER_PROTOCOL_REPRODUCIBLE_COMMAND,
} from "../src/app-server/protocol-provenance.js";
import { dispatchWithCompatibleAppServer } from "../src/app-server/dispatch.js";
import {
  guardAppServerVersion,
  APP_SERVER_VERSION,
} from "../src/app-server/version.js";
import {
  parseAskForApprovalFixture,
  parseErrorNotificationFixture,
  parseInitializeFixture,
  parseThreadFixture,
  parseThreadItemFixture,
  parseTurnFixture,
} from "../src/app-server/fixtures.js";

const fixtureDir = resolve(process.cwd(), "tests/fixtures/app-server");
const protocolDir = resolve(process.cwd(), "src/app-server/protocol");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), "utf8")) as T;
}

function listProtocolFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProtocolFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("app-server protocol artifacts", () => {
  it("pins the tested App Server compatibility range", () => {
    const check = guardAppServerVersion(() => "codex-cli 0.147.0");

    expect(check).toEqual({ ok: true, version: "0.147.0" });
    expect(APP_SERVER_VERSION).toBe("0.147.0");
    expect(APP_SERVER_PROTOCOL_PROVENANCE.generatorVersion).toBe("0.147.0");
    expect(APP_SERVER_PROTOCOL_PROVENANCE.testedVersion).toBe("0.147.0");
    expect(APP_SERVER_PROTOCOL_IMPORT_EXTENSION).toBe(".js");
    expect(APP_SERVER_PROTOCOL_REPRODUCIBLE_COMMAND).toBe(
      "pnpm generate:app-server-protocol",
    );
  });

  it("rejects unsupported and unparseable versions before dispatch", () => {
    expect(guardAppServerVersion(() => "codex-cli 0.146.9")).toEqual({
      ok: false,
      error: {
        code: "version_unsupported",
        version: "0.146.9",
        detail: expect.stringContaining("expected exactly 0.147.0"),
      },
    });

    expect(guardAppServerVersion(() => "codex-cli banana")).toEqual({
      ok: false,
      error: {
        code: "version_unparseable",
        version: "codex-cli banana",
        detail: expect.stringContaining("unable to parse"),
      },
    });
  });

  it("guards the dispatch boundary before invoking App Server", async () => {
    const dispatch = vi.fn(async () => "accepted");

    await expect(
      dispatchWithCompatibleAppServer(dispatch, () => "codex-cli 0.147.1"),
    ).resolves.toMatchObject({ ok: false, error: { code: "version_unsupported" } });
    expect(dispatch).not.toHaveBeenCalled();

    await expect(
      dispatchWithCompatibleAppServer(dispatch, () => "codex-cli 0.147.0"),
    ).resolves.toEqual({ ok: true, value: "accepted", version: "0.147.0" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("validates initialization, thread, turn, item, approval, and error fixtures", () => {
    const init = parseInitializeFixture(readJson("initialize.json"));
    const thread = parseThreadFixture(readJson("thread.json"));
    const turn = parseTurnFixture(readJson("turn.json"));
    const item = parseThreadItemFixture(readJson("item.json"));
    const approval = parseAskForApprovalFixture(readJson("approval.json"));
    const error = parseErrorNotificationFixture(readJson("error-notification.json"));

    expect(init.clientInfo.name).toBe("c2c-tests");
    expect(init.capabilities).toBeNull();

    expect(thread.status.type).toBe("active");
    expect(thread.turns).toEqual([]);
    expect(thread.gitInfo?.sha).toBe("a9f91cd98df1bc82686f57d5bc2b2993394c93be");

    expect(turn.itemsView).toBe("full");
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0]?.type).toBe("plan");

    expect(item.type).toBe("commandExecution");
    expect(item.command).toBe("pnpm test");

    expect(approval).toMatchObject({ granular: { sandbox_approval: true, request_permissions: true } });
    expect(error.error.message).toContain("unsupported protocol version");
  });

  it("rejects malformed fixtures", () => {
    expect(() =>
      parseThreadFixture({
        ...readJson("thread.json"),
        status: { type: "active", activeFlags: ["definitely-not-valid"] },
      }),
    ).toThrowError();

    expect(() =>
      parseThreadItemFixture({
        ...readJson("item.json"),
        commandActions: [{ unexpected: true }],
      }),
    ).toThrowError();
  });

  it("keeps generated ESM imports extensionful", () => {
    const generatedFiles = listProtocolFiles(protocolDir).filter((file) => file.endsWith(".ts"));

    expect(generatedFiles.length).toBeGreaterThan(0);
    for (const file of generatedFiles) {
      const contents = readFileSync(file, "utf8");
      const imports = contents.matchAll(/\bfrom\s+"([^"]+)"/g);
      for (const match of imports) {
        const specifier = match[1];
        if (specifier.startsWith(".")) {
          expect(specifier.endsWith(APP_SERVER_PROTOCOL_IMPORT_EXTENSION)).toBe(true);
        }
      }
    }
  });
});
