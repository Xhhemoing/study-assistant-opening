import { describe, expect, it, vi } from "vitest";
import { loadWorkerEnv } from "@aistudy/config";
import { OPENING_QUEUE_KINDS } from "./queue";
import { prepareWorkerRole } from "./worker-role";

const unconfigured = { status: "not_configured", directoryConfigured: false, directoryExists: false, missingFiles: [], inferenceMs: null } as const;
const health = () => ({ probe: vi.fn(async () => ({ ...unconfigured, missingFiles: [] })) });

describe("worker parser isolation", () => {
  it("starts learning consumers without inspecting an unavailable Python parser", async () => {
    const unavailableParser = vi.fn(async () => { throw new Error("PARSER_PYTHON is not an executable"); });
    const env = loadWorkerEnv({ WORKER_ROLE: "learning", PARSER_PYTHON: "/missing/python" });
    const report = health();
    const runtime = await prepareWorkerRole(env.workerRole, unavailableParser, report);
    expect(report.probe).not.toHaveBeenCalled();
    expect(runtime.refreshParserHealth).toBeNull();
    expect(unavailableParser).not.toHaveBeenCalled();
    expect(runtime.parserRunner).toBeNull();
    expect([...runtime.queueKinds].sort()).toEqual(OPENING_QUEUE_KINDS.filter(kind => kind !== "parse" && kind !== "parse-media").sort());
  });

  it.each(["all", "parser"] as const)("rejects %s startup when parser checks fail", async role => {
    const failure = new Error("Parser startup failed: missing OCR dependency");
    const check = vi.fn(async () => { throw failure; });
    await expect(prepareWorkerRole(role, check, health())).rejects.toBe(failure);
    expect(check).toHaveBeenCalledOnce();
  });

  it.each(["all", "parser"] as const)("checks the parser before enabling %s consumers", async role => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
    const check = vi.fn(async () => runner);
    const runtime = await prepareWorkerRole(role, check, health());
    expect(check).toHaveBeenCalledOnce();
    expect(runtime.parserRunner).toBe(runner);
    expect([...runtime.queueKinds]).toEqual(role === "all" ? [...OPENING_QUEUE_KINDS] : ["parse", "parse-media"]);
  });

  it("records missing files before startup failure and never claims readiness from configuration alone", async () => {
    const report = { status: "missing_files" as const, directoryConfigured: true, directoryExists: false, missingFiles: ["ppocr_keys_v1.txt"], inferenceMs: null };
    const record = vi.fn(async () => {});
    await expect(prepareWorkerRole("parser", async () => { throw new Error("OCR missing"); }, { probe: async () => report, record })).rejects.toThrow("OCR missing");
    expect(record).toHaveBeenCalledWith(report);
  });

  it("does not enable a parser consumer when tiny OCR inference fails", async () => {
    const record = vi.fn(async () => {});
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
    await expect(prepareWorkerRole("parser", async () => run, { record, probe: async () => ({ ...unconfigured, missingFiles: [], status: "preflight_failed", directoryConfigured: true }) })).rejects.toThrow("OCR startup failed");
  });

  it("supports periodic remeasurement and does not republish an old ready flag", async () => {
    const report = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 12 };
    const probe = vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce({ ...report, status: "preflight_failed", inferenceMs: null });
    const record = vi.fn(async () => {});
    const runtime = await prepareWorkerRole("parser", async () => async () => ({ exitCode: 0, stdout: "" }), { probe, record });
    await runtime.refreshParserHealth!();
    expect(record.mock.calls).toEqual([[report], [{ ...report, status: "preflight_failed", inferenceMs: null }]]);
  });
});
