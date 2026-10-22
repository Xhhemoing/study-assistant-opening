#!/usr/bin/env -S node --import tsx
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateGradingRun } from "../packages/ai/src/opening/grading-evaluation";

/** Reads explicit local evaluation files only; makes no provider call or database write. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node --import tsx scripts/study-grading-eval.ts --dataset FILE --results FILE [--output FILE]");
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--dataset", "--results", "--output"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid options; use --help");
    options.set(key, value);
  }
  if (!options.has("--dataset") || !options.has("--results")) throw new Error("Both dataset and results files are required");
  const output = options.get("--output");
  if (output && [options.get("--dataset")!, options.get("--results")!].some(input => resolve(input) === resolve(output))) {
    throw new Error("Output must not overwrite the dataset or results");
  }
  const report = evaluateGradingRun(JSON.parse(await readFile(options.get("--dataset")!, "utf8")),
    JSON.parse(await readFile(options.get("--results")!, "utf8")));
  const text = JSON.stringify(report, null, 2) + "\n";
  // Evaluation answers and photos may be private; create reports for the owner only.
  if (output) await writeFile(output, text, { encoding: "utf8", mode: 0o600, flag: "wx" }); else console.log(text);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Grading evaluation failed"); process.exitCode = 1; });
