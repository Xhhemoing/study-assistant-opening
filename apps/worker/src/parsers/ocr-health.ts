import { parseParserOcrHealth, type ParserOcrHealth } from "@aistudy/database";
import { createNodeRunner } from "./docling-process";
import type { ParserRunner } from "./types";
import { loadWorkerStartupConfig } from "@aistudy/config";

export const OCR_PREFLIGHT_TIMEOUT_MS = 120_000;
/** Run in the actual parser environment, not Web. No uploaded bytes or model API. */
export async function probeParserOcr(
  run?: ParserRunner,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<ParserOcrHealth> {
  const timeoutMs = loadWorkerStartupConfig(env).ocrTimeoutMs;
  const directoryConfigured = Boolean(env.PARSER_OCR_MODEL_DIR?.trim());
  if (!directoryConfigured) return { status: "not_configured", directoryConfigured: false, directoryExists: false, missingFiles: [], inferenceMs: null };
  try {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    const result = await (run ?? createNodeRunner())(["-m", "opening_parser.ocr"], combined);
    combined.throwIfAborted();
    if (result.exitCode !== 0) throw new Error("OCR preflight failed");
    return parseParserOcrHealth(JSON.parse(result.stdout));
  } catch {
    return { status: "preflight_failed", directoryConfigured, directoryExists: false, missingFiles: [], inferenceMs: null };
  }
}

/** A version, not a file hash: models are pinned, and file content is source-versioned.
 * Bump when extraction semantics/models change. Never reuse non-OCR output for OCR. */
export function pdfParserProfile(env: NodeJS.ProcessEnv = process.env): string {
  // v4 retains native/OCR provenance and embedded-image metadata after conversion.
  return `docling-2.126.0/pdf-segments-v4-visual/${env.PARSER_OCR_MODEL_DIR?.trim() ? "rapidocr-3.9.2-torch-ppocrv4" : "text"}`;
}
