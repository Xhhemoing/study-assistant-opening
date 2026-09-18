import { spawn } from "node:child_process";
import path from "node:path";
import type { ParseDocument, ParsedPage, ParserRunner } from "./types";

export class UnsupportedMimeError extends Error { readonly code = "UNSUPPORTED_MIME"; }
export class BoundsExceededError extends Error { readonly code = "BOUNDS_EXCEEDED"; }
export class ConversionFailedError extends Error { readonly code = "CONVERSION_FAILED"; }
export class UsageError extends Error { readonly code = "USAGE"; }

export function decodeParserOutput(text: string): ParsedPage[] {
  // Library log lines may precede the payload despite the CLI's suppression;
  // the JSON object starts at the first "{".
  const start = text.indexOf("{");
  const value: unknown = JSON.parse(start < 0 ? text : text.slice(start));
  if (!value || typeof value !== "object" || !Array.isArray((value as { pages?: unknown }).pages)) throw new TypeError("invalid parser output");
  const pages = (value as { pages: unknown[] }).pages.map((item) => {
    if (!item || typeof item !== "object") throw new TypeError("invalid page");
    const page = item as Record<string, unknown>;
    if (!Number.isInteger(page.page) || (page.page as number) < 1) throw new RangeError("invalid page number");
    if (typeof page.text !== "string" || !(page.imagePath === null || typeof page.imagePath === "string")) throw new TypeError("invalid page shape");
    return { page: page.page as number, text: page.text, imagePath: page.imagePath as string | null };
  });
  if (new Set(pages.map((page) => page.page)).size !== pages.length) throw new RangeError("duplicate page number");
  return pages;
}

export function createDoclingProcess(deps: { run: ParserRunner; maxPages?: number }): { parseDocument: ParseDocument } {
  return { async parseDocument(input, signal) {
    // CPU-only docling runs minutes per deck; a short wall-clock cap turns
    // legitimate large conversions into exit-4 failures (observed: three
    // concurrent 50–72-page math slides all timed out together).
    const result = await deps.run(["-m", "opening_parser", "--input", input.path, "--mime", input.mime, "--max-pages", String(input.maxPages), "--timeout-seconds", String(input.timeoutSeconds ?? 900)], signal);
    if (result.exitCode === 0) return decodeParserOutput(result.stdout);
    if (result.exitCode === 3) throw new UnsupportedMimeError("unsupported source MIME");
    if (result.exitCode === 5) throw new BoundsExceededError("parser bounds exceeded");
    if (result.exitCode === 2) throw new UsageError("parser usage error");
    const reason = result.stderr ? `: ${result.stderr.slice(-300)}` : "";
    throw new ConversionFailedError(`document conversion failed${reason}`);
  } };
}

export function createNodeRunner(pythonExecutable = process.env.PARSER_PYTHON ?? path.resolve(process.cwd(), ".local/docling-venv/Scripts/python.exe"), cwd = process.env.PARSER_CWD ?? path.resolve(process.cwd(), "services/parser")): ParserRunner {
  return (argv, signal) => new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, argv, { cwd, signal, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { if (Buffer.byteLength(stdout) < 2 * 1024 * 1024) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      // Non-zero conversions carry the CLI's reason on stderr; surfacing the
      // tail turns opaque "conversion failed" jobs into diagnosable ones.
      const detail = exitCode ? stderr.slice(-400).replace(/\s+$/, "") : "";
      resolve({ exitCode: exitCode ?? 4, stdout, stderr: detail });
    });
  });
}
