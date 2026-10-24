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
  return async (argv, signal, stream) => {
    signal.throwIfAborted();
    // Detached process groups include model/conversion descendants, not just Python.
    const child = spawn(pythonExecutable, argv, { cwd, detached: process.platform !== "win32", windowsHide: true, env: createParserSubprocessEnv("python") });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const bound = 8 * 1024 * 1024;
    let stdoutBytes = 0, stderrBytes = 0;
    let failed = false, failure: unknown;
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
    const fail = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      killTree();
    };
    const abort = () => fail(signal.reason);
    const closed = new Promise<number | null>(resolve => {
      child.on("error", fail);
      child.on("close", resolve);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stderr.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, 64 * 1024 - stderrBytes));
      if (kept.length) stderr.push(kept);
      stderrBytes += kept.length;
    });
    // An async iterator pauses the readable while the callback is awaiting its
    // fenced DB write. Never queue one promise per line or retain streamed stdout.
    const consumed = (async () => {
      let fragments: Buffer[] = [];
      let lineBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const emit = async (line: Buffer) => {
        if (failed) return;
        if (line.length > bound) throw new BoundsExceededError("parser line exceeds capture bound");
        await stream!.onLine(decoder.decode(line).replace(/\r$/, ""));
      };
      try {
        for await (const chunk of child.stdout) {
          if (failed) continue;
          const bytes = chunk as Buffer;
          stdoutBytes += bytes.length;
          if (stdoutBytes > bound) throw new BoundsExceededError("parser stdout exceeds capture bound");
          if (!stream) { stdout.push(bytes); continue; }
          // Search only this chunk, retaining slices without copying an ever-
          // growing prefix. Assemble a fragmented line exactly once, at emission.
          let offset = 0, newline: number;
          while ((newline = bytes.indexOf(10, offset)) !== -1) {
            const tail = bytes.subarray(offset, newline);
            let line = tail;
            if (fragments.length) {
              fragments.push(tail);
              line = Buffer.concat(fragments, lineBytes + tail.length);
              fragments = [];
              lineBytes = 0;
            }
            await emit(line);
            offset = newline + 1;
            if (failed) break;
          }
          if (!failed && offset < bytes.length) {
            const tail = bytes.subarray(offset);
            fragments.push(tail);
            lineBytes += tail.length;
            if (lineBytes > bound) throw new BoundsExceededError("parser line exceeds capture bound");
          }
        }
        if (stream && lineBytes && !failed) {
          await emit(fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, lineBytes));
        }
      } catch (error) { fail(error); }
    })();
    // close may precede an in-flight callback. Both must drain before the input
    // file is removed by the caller; callback rejections are always observed.
    const [exitCode] = await Promise.all([closed, consumed]);
    signal.removeEventListener("abort", abort);
    if (failed) throw failure;
    return { exitCode: exitCode ?? 4, stdout: stream ? "" : Buffer.concat(stdout).toString("utf8"),
      stderr: exitCode ? Buffer.concat(stderr).toString("utf8").slice(-400).trimEnd() : "" };
  };
}
