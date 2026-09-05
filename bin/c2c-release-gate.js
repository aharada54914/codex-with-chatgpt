#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "release", "cli.js");

if (existsSync(dist)) {
  const { main } = await import(pathToFileURL(dist).href);
  await main();
} else {
  const entry = path.join(here, "..", "src", "release", "cli.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
