import { spawn } from "node:child_process";
import path from "node:path";
import type { ParseDocument, ParsedPage, ParserRunner } from "./types";

export class UnsupportedMimeError extends Error { readonly code = "UNSUPPORTED_MIME"; }
export class BoundsExceededError extends Error { readonly code = "BOUNDS_EXCEEDED"; }
export class ConversionFailedError extends Error { readonly code = "CONVERSION_FAILED"; }
export class UsageError extends Error { readonly code = "USAGE"; }

export function decodeParserOutput(text: string): ParsedPage[] {
  const value: unknown = JSON.parse(text);
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
    const result = await deps.run(["-m", "opening_parser", "--input", input.path, "--mime", input.mime, "--max-pages", String(input.maxPages)], signal);
    if (result.exitCode === 0) return decodeParserOutput(result.stdout);
    if (result.exitCode === 3) throw new UnsupportedMimeError("unsupported source MIME");
    if (result.exitCode === 5) throw new BoundsExceededError("parser bounds exceeded");
    if (result.exitCode === 2) throw new UsageError("parser usage error");
    throw new ConversionFailedError("document conversion failed");
  } };
}

export function createNodeRunner(pythonExecutable = process.env.PARSER_PYTHON ?? path.resolve(process.cwd(), ".local/docling-venv/Scripts/python.exe"), cwd = process.env.PARSER_CWD ?? path.resolve(process.cwd(), "services/parser")): ParserRunner {
  return (argv, signal) => new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, argv, { cwd, signal, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { if (Buffer.byteLength(stdout) < 2 * 1024 * 1024) stdout += chunk.toString(); });
    child.stderr.on("data", () => { /* capped and intentionally excluded from errors */ });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 4, stdout }));
  });
}
