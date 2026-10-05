import { spawn } from "node:child_process";
import { loadParserConfig } from "./parser-config";

type PageRequest = { sourceId: string; physicalPage: number };
export type PdfPageImage = { sourceId: string; physicalPage: number; mediaType: "image/png"; data: string };
export async function renderPdfPageImages(bytes: Uint8Array, requests: readonly PageRequest[], config = loadParserConfig()): Promise<PdfPageImage[]> {
  if (requests.length < 1 || requests.length > 3 || requests.some(item => !Number.isInteger(item.physicalPage) || item.physicalPage < 1)) throw new Error("invalid PDF page selection");
  const child = spawn(config.pythonExecutable, ["-m", "opening_parser.render_pages", JSON.stringify(requests.map(item => item.physicalPage))], { cwd: config.cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", HF_HUB_OFFLINE: "1" } });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => errors.push(Buffer.from(chunk)));
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    child.stdin.on("error", () => { /* Process close reports a failed render; avoid an unhandled EPIPE. */ });
    child.stdin.end(Buffer.from(bytes));
    const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", value => resolve(value ?? 4)); });
    if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8").trim() || "PDF page rendering failed");
    const values = JSON.parse(Buffer.concat(output).toString("utf8")) as unknown;
    if (!Array.isArray(values) || values.length !== requests.length || values.some(value => typeof value !== "string" || value.length > 2_800_000 || !value.startsWith("data:image/png;base64,"))) throw new Error("invalid rendered page image");
    return values.map((data, index) => ({ ...requests[index]!, mediaType: "image/png" as const, data }));
  } finally { clearTimeout(timer); }
}
