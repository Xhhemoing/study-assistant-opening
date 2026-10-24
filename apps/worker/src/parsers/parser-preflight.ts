import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createNodeRunner } from "./docling-process";
import { loadParserConfig, type ParserConfig } from "./parser-config";
import type { ParserRunner } from "./types";

export async function preflightParser(config: ParserConfig = loadParserConfig()): Promise<ParserRunner> {
  try {
    if (!(await stat(config.cwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`PARSER_CWD is not a parser directory: ${config.cwd}. Set it to services/parser or the deployed parser package.`);
  }
  try {
    await access(config.pythonExecutable, constants.X_OK);
  } catch {
    throw new Error(`PARSER_PYTHON is not an executable: ${config.pythonExecutable}. Create the parser venv and install services/parser/requirements-lock.txt.`);
  }
  const runner = createNodeRunner(config);
  try {
    // Cold Docling/Torch imports took 70s on the shared production host.
    // Keep a bounded preflight, but do not reject a healthy cold parser at 30s.
    const result = await runner(["-m", "opening_parser", "--check"], AbortSignal.timeout(120_000));
    if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
  } catch (error) {
    throw new Error(`Parser startup failed (${config.pythonExecutable} -m opening_parser --check): ${String(error)}. Check PARSER_PYTHON/PARSER_CWD and install services/parser/requirements-lock.txt.`);
  }
  return runner;
}
