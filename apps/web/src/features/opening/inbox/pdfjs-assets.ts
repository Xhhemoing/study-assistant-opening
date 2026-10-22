import "server-only";
import { readFile } from "node:fs/promises";
import nodeModule from "node:module";
import path from "node:path";

// Keep this a runtime Node lookup; webpack rewrites a named createRequire import.
// The pinned public resources are explicitly included in next.config.mjs tracing.
const require = nodeModule.createRequire(path.join(process.cwd(), "package.json"));
export const pdfAssetVersion = "5.4.624";
const extensions: Record<string, RegExp> = { cmaps: /\.bcmap$/, standard_fonts: /\.(?:pfb|ttf)$/, wasm: /\.(?:wasm|js)$/, iccs: /\.icc$/ };

/** Serves only the pinned distribution's public rendering resources, never user files. */
export async function readPdfAsset(version: string, kind: string, filename: string): Promise<{ body: Uint8Array; contentType: string } | null> {
  if (version !== pdfAssetVersion || !Object.hasOwn(extensions, kind) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(filename) || !extensions[kind]!.test(filename)) return null;
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  try {
    const body = await readFile(path.join(packageRoot, kind, filename));
    const contentType = filename.endsWith(".wasm") ? "application/wasm" : filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".ttf") ? "font/ttf" : "application/octet-stream";
    return { body: new Uint8Array(body), contentType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
