import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkedInDirectory = resolve(repositoryRoot, "src/app-server/protocol");
const temporaryRoot = mkdtempSync(join(tmpdir(), "c2c-app-server-protocol-"));
const rawDirectory = resolve(temporaryRoot, "raw");
const normalizedDirectory = resolve(temporaryRoot, "normalized");
const expectedGeneratorVersion = "0.147.0";

function assertGeneratorVersion() {
  const output = execFileSync("codex", ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  }).trim();
  const version = output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  if (version !== expectedGeneratorVersion) {
    throw new Error(
      `unsupported Codex protocol generator ${JSON.stringify(output)}; expected exactly codex-cli ${expectedGeneratorVersion}`,
    );
  }
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

function addJavaScriptExtensions(source, sourceFile) {
  return source.replace(
    /\b(from\s+|import\s*)"(\.{1,2}\/[^"\n]+)"/g,
    (match, prefix, specifier) => {
      if (/\.(?:js|json)$/.test(specifier)) return match;
      const target = resolve(dirname(sourceFile), specifier);
      const generatedSpecifier = readdirSync(dirname(target)).some(
        (entry) => entry === `${target.split("/").at(-1)}.ts`,
      )
        ? `${specifier}.js`
        : `${specifier}/index.js`;
      return `${prefix}"${generatedSpecifier}"`;
    },
  );
}

function normalizeGeneratedTree() {
  cpSync(rawDirectory, normalizedDirectory, { recursive: true });
  for (const file of listFiles(normalizedDirectory)) {
    if (!file.endsWith(".ts")) continue;
    writeFileSync(file, addJavaScriptExtensions(readFileSync(file, "utf8"), file));
  }

  const generatedIndex = resolve(normalizedDirectory, "index.ts");
  const generatedIndexContents = readFileSync(generatedIndex, "utf8");
  writeFileSync(resolve(normalizedDirectory, "index.generated.ts"), generatedIndexContents);
  writeFileSync(generatedIndex, 'export * from "./index.generated.js";\n');
}

function snapshot(directory) {
  return new Map(
    listFiles(directory).map((file) => [relative(directory, file), readFileSync(file, "utf8")]),
  );
}

function assertCheckedInTreeMatches() {
  const expected = snapshot(normalizedDirectory);
  const actual = snapshot(checkedInDirectory);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const differences = paths.filter((path) => expected.get(path) !== actual.get(path));
  if (differences.length > 0) {
    throw new Error(
      `checked-in App Server protocol is stale; run pnpm generate:app-server-protocol\n${differences.join("\n")}`,
    );
  }
}

try {
  assertGeneratorVersion();
  execFileSync("codex", ["app-server", "generate-ts", "--out", rawDirectory], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  normalizeGeneratedTree();

  if (process.argv.includes("--check")) {
    assertCheckedInTreeMatches();
  } else {
    rmSync(checkedInDirectory, { recursive: true, force: true });
    cpSync(normalizedDirectory, checkedInDirectory, { recursive: true });
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
