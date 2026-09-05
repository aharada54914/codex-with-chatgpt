import {
  guardAppServerVersion,
  readAppServerVersion,
  type AppServerVersionGuardError,
  type ReadAppServerVersion,
} from "./version.js";

export type AppServerDispatchResult<T> =
  | { ok: true; value: T; version: string }
  | { ok: false; error: AppServerVersionGuardError };

export async function dispatchWithCompatibleAppServer<T>(
  dispatch: () => Promise<T>,
  readVersion: ReadAppServerVersion = readAppServerVersion,
): Promise<AppServerDispatchResult<T>> {
  const compatibility = guardAppServerVersion(readVersion);
  if (!compatibility.ok) return compatibility;

  return {
    ok: true,
    value: await dispatch(),
    version: compatibility.version,
  };
}
