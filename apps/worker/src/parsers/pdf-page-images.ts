import { spawn } from "node:child_process";
import { loadParserConfig } from "./parser-config";
import { createParserSubprocessEnv } from "./subprocess-env";

const MAX_IMAGE_DATA_LENGTH = 2_800_000;
const MAX_RENDER_ERROR_BYTES = 64 * 1024;

type PageRequest = { sourceId: string; physicalPage: number };
export type PdfPageImage = { sourceId: string; physicalPage: number; mediaType: "image/png"; data: string };
export async function renderPdfPageImages(bytes: Uint8Array, requests: readonly PageRequest[], config = loadParserConfig()): Promise<PdfPageImage[]> {
  if (requests.length < 1 || requests.length > 3 || requests.some(item => !Number.isInteger(item.physicalPage) || item.physicalPage < 1)) throw new Error("invalid PDF page selection");
  // The renderer opens one PDF document for this entire ordered batch and
  // closes native page and document handles before the child reports completion.
  const child = spawn(config.pythonExecutable, ["-m", "opening_parser.render_pages", JSON.stringify(requests.map(item => item.physicalPage))], { cwd: config.cwd, windowsHide: true, env: createParserSubprocessEnv("python") });
  const completed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 4));
  });
  const output: Buffer[] = [], errors: Buffer[] = [];
  // PNG data URLs are ASCII. Allow framing for the JSON array and newline.
  const maxOutputBytes = requests.length * (MAX_IMAGE_DATA_LENGTH + 4) + 3;
  let outputBytes = 0, errorBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    if (outputBytes > maxOutputBytes) return;
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) child.kill();
    else output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = MAX_RENDER_ERROR_BYTES - errorBytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    errors.push(kept);
    errorBytes += kept.length;
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    child.stdin.on("error", () => { /* Process close reports a failed render; avoid an unhandled EPIPE. */ });
    child.stdin.end(bytes);
    const code = await completed;
    if (outputBytes > maxOutputBytes) throw new Error("rendered PDF output exceeds capture bound");
    if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8").trim() || "PDF page rendering failed");
    const values = JSON.parse(Buffer.concat(output).toString("utf8")) as unknown;
    if (!Array.isArray(values) || values.length !== requests.length || values.some(value => typeof value !== "string" || value.length > MAX_IMAGE_DATA_LENGTH || !value.startsWith("data:image/png;base64,"))) throw new Error("invalid rendered page image");
    return values.map((data, index) => ({ ...requests[index]!, mediaType: "image/png" as const, data }));
  } finally { clearTimeout(timer); }
}
