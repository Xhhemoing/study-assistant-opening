#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_NAME,
  formatConfig,
  formatStatus,
  parseArgs,
  redact,
  resolveManifestPath,
} from "./notion-meeting-pipeline/cli-options.mjs";
import { main as runMain } from "./notion-meeting-pipeline/cli-runner.mjs";

export {
  CLI_NAME,
  formatConfig,
  formatStatus,
  parseArgs,
  resolveManifestPath,
};

export async function main(argv = process.argv.slice(2)) {
  return runMain(argv, parseArgs);
}

export { redact };

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === path.resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
