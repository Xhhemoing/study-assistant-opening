#!/usr/bin/env -S node --import tsx
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateTutorL0 } from "../packages/domain/src/opening/tutor-l0-evaluation";

/** Manual, local-only evaluation. Never calls a provider or connects to a database. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node --import tsx scripts/evaluate-tutor-l0.ts [--fixture FILE] [--output FILE]");
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--fixture", "--output"].includes(key) || !value || value.startsWith("--") || options.has(key)) {
      throw new Error("Invalid options; use --help");
    }
    options.set(key, value);
  }
  const fixturePath = resolve(options.get("--fixture") ?? "tests/fixtures/opening/tutor-l0-cases.json");
  const outputPath = options.has("--output") ? resolve(options.get("--output")!) : null;
  if (outputPath === fixturePath || outputPath === await realpath(fixturePath)) throw new Error("Output must not overwrite the fixture");
  const report = evaluateTutorL0(JSON.parse(await readFile(fixturePath, "utf8")));
  const text = JSON.stringify(report, null, 2) + "\n";
  // Do not overwrite existing files or follow an existing symlink. Reports are private.
  if (outputPath) await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  else console.log(text);
  if (report.summary.failed > 0) process.exitCode = 1;
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Offline tutor evaluation failed");
  process.exitCode = 1;
});
