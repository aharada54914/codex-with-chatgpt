import { execFileSync } from "node:child_process";

export const APP_SERVER_VERSION = "0.147.0";

export type AppServerVersionCheck = {
  version: string | null;
  compatible: boolean;
  detail?: string;
};

export type AppServerVersionGuardErrorCode =
  | "version_unavailable"
  | "version_unparseable"
  | "version_unsupported";

export type AppServerVersionGuardError = {
  code: AppServerVersionGuardErrorCode;
  version: string | null;
  detail: string;
};

export type AppServerVersionGuardResult =
  | { ok: true; version: string }
  | { ok: false; error: AppServerVersionGuardError };

export type ReadAppServerVersion = () => string;

export function isSupportedAppServerVersion(version: string | null): boolean {
  return version === APP_SERVER_VERSION;
}

export function checkAppServerVersion(version: string | null): AppServerVersionCheck {
  const parsedVersion = version ? version.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null : null;
  const checkedVersion = parsedVersion ?? version;
  if (!checkedVersion) {
    return {
      version: null,
      compatible: false,
      detail: `unable to read Codex App Server version; expected exactly ${APP_SERVER_VERSION}`,
    };
  }
  if (!isSupportedAppServerVersion(checkedVersion)) {
    return {
      version: checkedVersion,
      compatible: false,
      detail: `unsupported Codex App Server version ${checkedVersion}; expected exactly ${APP_SERVER_VERSION}`,
    };
  }
  return { version: checkedVersion, compatible: true };
}

export function readAppServerVersion(): string {
  return execFileSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  }).trim();
}

export function guardAppServerVersion(readVersion: ReadAppServerVersion = readAppServerVersion): AppServerVersionGuardResult {
  let versionText: string;
  try {
    versionText = readVersion();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "version_unavailable",
        version: null,
        detail: error instanceof Error ? error.message : "unable to read Codex App Server version",
      },
    };
  }

  const parsedVersion = versionText.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  if (!parsedVersion) {
    return {
      ok: false,
      error: {
        code: "version_unparseable",
        version: versionText,
        detail: `unable to parse Codex App Server version from ${JSON.stringify(versionText)}; expected exactly ${APP_SERVER_VERSION}`,
      },
    };
  }

  const check = checkAppServerVersion(parsedVersion);
  if (!check.compatible) {
    return {
      ok: false,
      error: {
        code: "version_unsupported",
        version: parsedVersion,
        detail: check.detail ?? `unsupported Codex App Server version ${parsedVersion}`,
      },
    };
  }

  return { ok: true, version: parsedVersion };
}
