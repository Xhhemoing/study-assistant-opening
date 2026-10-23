import { spawn } from "node:child_process";
import { loadParserConfig, type ParserConfig } from "./parser-config";
import type { ParseDocument, ParsedPage, ParserRunner } from "./types";
import { createParserSubprocessEnv } from "./subprocess-env";

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
    const timeoutSeconds = input.timeoutSeconds ?? 900;
    const argv = ["-m", "opening_parser", "--input", input.path, "--mime", input.mime, "--max-pages", String(input.maxPages), "--timeout-seconds", String(timeoutSeconds)];
    if (input.pageStart !== undefined && input.pageEnd !== undefined) argv.push("--page-start", String(input.pageStart), "--page-end", String(input.pageEnd));
    // The outer deadline includes imports/model initialization, which the
    // Python conversion thread timeout cannot cover.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000)]);
    deadline.throwIfAborted();
    const result = await deps.run(argv, deadline);
    deadline.throwIfAborted();
    if (result.exitCode === 0) return decodeParserOutput(result.stdout);
    if (result.exitCode === 3) throw new UnsupportedMimeError("unsupported source MIME");
    if (result.exitCode === 5) throw new BoundsExceededError("parser bounds exceeded");
    if (result.exitCode === 2) throw new UsageError("parser usage error");
    const reason = result.stderr ? `: ${result.stderr.slice(-300)}` : "";
    throw new ConversionFailedError(`document conversion failed${reason}`);
  } };
}

export function createNodeRunner({ pythonExecutable, cwd }: ParserConfig = loadParserConfig()): ParserRunner {
  return (argv, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    // Own a process group so cancellation also kills subprocess descendants.
    // Do not settle until close: callers may then safely remove the input file.
    const child = spawn(pythonExecutable, argv, { cwd, detached: process.platform !== "win32", windowsHide: true, env: createParserSubprocessEnv("python") });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let failure: unknown;
    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", env: createParserSubprocessEnv("media") });
        killer.on("error", () => child.kill("SIGKILL"));
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
      }
    };
    const abort = () => { failure = signal.reason; killTree(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 8 * 1024 * 1024) { failure = new BoundsExceededError("parser stdout exceeds capture bound"); killTree(); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, 64 * 1024 - stderrBytes));
      if (kept.length) stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.on("error", error => { failure = error; });
    child.on("close", (exitCode) => {
      signal.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      const detail = exitCode ? Buffer.concat(stderr).toString("utf8").slice(-400).trimEnd() : "";
      resolve({ exitCode: exitCode ?? 4, stdout: Buffer.concat(stdout).toString("utf8"), stderr: detail });
    });
  });
}
