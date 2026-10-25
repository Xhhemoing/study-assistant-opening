import { describe, expect, it, vi } from "vitest";
import { loadWorkerEnv } from "@aistudy/config";
import { OPENING_QUEUE_KINDS } from "./queue";
import { prepareWorkerRole, reconcileParserConsumers } from "./worker-role";
import { createParserHealthLease } from "./parser-health-lease";

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
    await runtime.parserRunner!([], new AbortController().signal);
    expect(runner).toHaveBeenCalledOnce();
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

  it("reuses health while busy only with recent successful decoded parse/segment evidence", async () => {
    let clock = 0;
    let finish!: (value: { exitCode: number; stdout: string }) => void;
    const output = { exitCode: 0, stdout: JSON.stringify({ pages: [{ page: 1, text: "segment", imagePath: null }] }) };
    const runner = vi.fn().mockResolvedValueOnce(output).mockImplementation(() => new Promise(done => { finish = done; }));
    const report = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 12 };
    const probe = vi.fn(async () => report), record = vi.fn(async () => {});
    const runtime = await prepareWorkerRole("all", async () => runner, { probe, record, now: () => clock, evidenceTtlMs: 1000 });
    await runtime.parserRunner!(["--input", "segment-1"], new AbortController().signal);
    const busy = runtime.parserRunner!(["--input", "segment-2"], new AbortController().signal);
    clock = 500; await runtime.refreshParserHealth!();
    expect(probe).toHaveBeenCalledTimes(1); expect(record).toHaveBeenCalledTimes(2);
    clock = 1000; await runtime.refreshParserHealth!();
    expect(probe).toHaveBeenCalledTimes(2);
    finish(output); await busy;
    await runtime.refreshParserHealth!(); expect(probe).toHaveBeenCalledTimes(3);
  });

  it("never renews from busy alone or a failed parse", async () => {
    let finish!: (value: { exitCode: number; stdout: string }) => void;
    const report = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 12 };
    const probe = vi.fn(async () => report);
    const runtime = await prepareWorkerRole("parser", async () => () => new Promise(done => { finish = done; }), { probe });
    const busy = runtime.parserRunner!(["--input", "segment"], new AbortController().signal);
    await runtime.refreshParserHealth!(); await runtime.refreshParserHealth!();
    expect(probe).toHaveBeenCalledTimes(3);
    finish({ exitCode: 4, stdout: "" }); await busy;
    await runtime.refreshParserHealth!(); expect(probe).toHaveBeenCalledTimes(4);
  });

  it("keeps role=all learning writes alive through three OCR failures, pause and recovery on the same consumers", async () => {
    const report = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 12 };
    const failed = { ...report, status: "preflight_failed" as const, inferenceMs: null };
    const probe = vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed).mockResolvedValueOnce(failed).mockResolvedValue(report);
    const runtime = await prepareWorkerRole("all", async () => async () => ({ exitCode: 0, stdout: "" }), { probe });
    const writes = vi.fn();
    const consumers = [...runtime.queueKinds].map(kind => ({ kind, paused: false,
      pause: vi.fn(async function (this: { paused: boolean }) { this.paused = true; }),
      resume: vi.fn(async function (this: { paused: boolean }) { this.paused = false; }) }));
    const lease = createParserHealthLease({ reportedAt: performance.now(), refresh: runtime.refreshParserHealth!, onUnavailable: vi.fn() });
    try {
      for (let i = 0; i < 3; i++) {
        await expect(lease.renew()).rejects.toThrow(/preflight failed/);
        await reconcileParserConsumers(consumers, lease.isCurrent, () => false);
        for (const consumer of consumers) if (!consumer.paused && consumer.kind === "tutor") writes("learning saved");
      }
      expect(writes).toHaveBeenCalledTimes(3);
      expect(consumers.filter(c => c.paused).map(c => c.kind)).toEqual(["parse", "parse-media"]);
      for (const consumer of consumers.filter(c => c.kind !== "parse" && c.kind !== "parse-media")) {
        expect(consumer.pause).not.toHaveBeenCalled(); expect(consumer.resume).not.toHaveBeenCalled();
      }
      await lease.renew(); await reconcileParserConsumers(consumers, lease.isCurrent, () => false);
      expect(consumers.every(c => !c.paused)).toBe(true);
      expect(consumers).toHaveLength(runtime.queueKinds.size);
      const before = consumers.map(c => c.resume.mock.calls.length);
      await reconcileParserConsumers(consumers, lease.isCurrent, () => true);
      expect(consumers.map(c => c.resume.mock.calls.length)).toEqual(before);
    } finally { lease.stop(); }
  });
});
