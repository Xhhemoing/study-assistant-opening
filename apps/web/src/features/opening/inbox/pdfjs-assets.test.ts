import { expect, it } from "vitest";
import { pdfAssetVersion, readPdfAsset } from "./pdfjs-assets";

it.each([
  ["cmaps", "Adobe-GB1-UCS2.bcmap", "application/octet-stream"],
  ["standard_fonts", "LiberationSans-Regular.ttf", "font/ttf"],
  ["wasm", "openjpeg.wasm", "application/wasm"],
  ["wasm", "openjpeg_nowasm_fallback.js", "text/javascript"],
  ["iccs", "CGATS001Compat-v2-micro.icc", "application/octet-stream"],
])("loads matching local PDF.js %s resource", async (kind, filename, contentType) => {
  const asset = await readPdfAsset(pdfAssetVersion, kind, filename);
  expect(asset?.body.byteLength).toBeGreaterThan(0);
  expect(asset?.contentType).toBe(contentType);
});

it.each([
  [pdfAssetVersion, "..", "package.json"], [pdfAssetVersion, "cmaps", "../package.json"],
  [pdfAssetVersion, "cmaps", "%2e%2e%2fpackage.json"], [pdfAssetVersion, "cmaps", "package.json"],
  ["old", "cmaps", "Adobe-GB1-UCS2.bcmap"], [pdfAssetVersion, "wasm", "missing.wasm"],
])("rejects paths outside the matching rendering distribution", async (version, kind, filename) => {
  expect(await readPdfAsset(version, kind, filename)).toBeNull();
});
