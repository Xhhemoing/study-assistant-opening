import { describe, expect, it, vi } from "vitest";
import { probeParserOcr, pdfParserProfile } from "./ocr-health";

const configured = { PARSER_OCR_MODEL_DIR: "/prepared/private-models" } as NodeJS.ProcessEnv;
describe("Worker OCR measurements", () => {
  it("does not start Python when OCR is not configured", async () => {
    const run = vi.fn();
    expect(await probeParserOcr(run, {} as NodeJS.ProcessEnv)).toMatchObject({ status: "not_configured" });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["missing_files", "preflight_failed", "ready"] as const)("reads measured %s from the actual parser subprocess", async status => {
    const report = { status, directoryConfigured: true, directoryExists: true, missingFiles: status === "missing_files" ? ["ppocr_keys_v1.txt"] : [], inferenceMs: status === "ready" ? 20 : null };
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(report) }));
    expect(await probeParserOcr(run, configured)).toEqual(report);
    expect(run.mock.calls[0]?.[0]).toEqual(["-m", "opening_parser.ocr"]);
  });
  it("turns timeout/import/crash or a false ready payload into preflight_failed without leaking stderr", async () => {
    for (const run of [async () => { throw new Error("private path"); }, async () => ({ exitCode: 4, stdout: "", stderr: "private path" }),
      async () => ({ exitCode: 0, stdout: JSON.stringify({ status: "ready", directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: null }) })]) {
      const report = await probeParserOcr(run, configured);
      expect(report.status).toBe("preflight_failed");
      expect(JSON.stringify(report)).not.toContain("private");
    }
  });
  it("versions physical-page extraction separately from the old merged-charspan cache", () => {
    expect(pdfParserProfile({})).toBe("docling-2.126.0/pdf-segments-v2/text");
    expect(pdfParserProfile(configured)).toBe("docling-2.126.0/pdf-segments-v2/rapidocr-3.9.2-torch-ppocrv4");
  });
  it("separates OCR and text caches without embedding private model paths", () => {
    expect(pdfParserProfile(configured)).not.toBe(pdfParserProfile({} as NodeJS.ProcessEnv));
    expect(pdfParserProfile(configured)).not.toContain("/prepared");
  });
});
