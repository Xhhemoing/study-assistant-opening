import { describe, expect, it, vi } from "vitest";
import type { OpeningPdfSegmentsRepository, PdfSegment, PdfSegmentIdentity } from "@aistudy/database";
import { parsePdfSegments, watchPdfExecution } from "./pdf-segments";
import { pdfParserProfile } from "./ocr-health";
import type { ParserRunner } from "./types";

const scope = { workspaceId: "w", ownerUserId: "u", jobExecution: { id: "job", token: "claim", privacyEpoch: 0 } };
function setup(total = 23) {
  const data = new Map<string, PdfSegment>();
  const key = (i: PdfSegmentIdentity) => `${i.sourceId}/${i.sourceVersion}/${i.parserProfile}/${i.pageStart}-${i.pageEnd}`;
  const segments: OpeningPdfSegmentsRepository = {
    assertCurrent: vi.fn(async () => {}),
    read: vi.fn(async (_scope, i) => data.get(key(i)) ?? null),
    save: vi.fn(async (_scope, i, value) => { data.set(key(i), value); }),
  };
  const ranges: number[][] = [];
  const failures = new Set<number>();
  const batches: string[] = [];
  const runner: ParserRunner = vi.fn(async (argv, signal, stream) => {
    if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: total }) };
    const requested = argv[argv.indexOf("--ranges") + 1]!;
    batches.push(requested);
    let exitCode = 0;
    for (const range of requested.split(",")) {
      const [start, end] = range.split("-").map(Number) as [number, number];
      ranges.push([start, end]);
      signal.throwIfAborted();
      const row = failures.has(start) ? { range: [start, end], error: "conversion_failed" }
        : { range: [start, end], pages: Array.from({ length: end - start + 1 }, (_, index) => ({ page: start + index, text: `page ${start + index}`, imagePath: null })) };
      await stream!.onLine(JSON.stringify(row));
      if (failures.has(start)) exitCode = 4;
    }
    return { exitCode, stdout: "" };
  });
  const controller = new AbortController();
  const input = { path: "/document", sourceId: "source", sourceVersion: 0, scope, runner, segments, signal: controller.signal, parserProfile: "text-v1" };
  return { input, ranges, batches, failures, data, controller, segments };
}

describe("bounded resumable PDF parser", () => {
  it("passes initial source version zero unchanged through cache read/save and reuses it", async () => {
    const d = setup(2);
    const first = await parsePdfSegments(d.input);
    expect(d.segments.read).toHaveBeenCalledWith(scope, expect.objectContaining({ sourceVersion: 0 }));
    expect(d.segments.save).toHaveBeenCalledWith(scope, expect.objectContaining({ sourceVersion: 0 }),
      { state: "ready", pages: first }, d.input.signal);
    d.ranges.length = 0;
    expect(await parsePdfSegments(d.input)).toEqual(first);
    expect(d.ranges).toEqual([]);
  });

  it("does not reuse the old merged-charspan cache after the physical-page extraction upgrade", async () => {
    const d = setup(2);
    const legacyProfile = "docling-2.126.0/pdf-segments-v1/text";
    await parsePdfSegments({ ...d.input, parserProfile: legacyProfile });
    const profile = pdfParserProfile({});
    expect(profile).not.toBe(legacyProfile);
    d.ranges.length = 0;
    await parsePdfSegments({ ...d.input, parserProfile: profile });
    expect(d.ranges).toEqual([[1, 2]]);
    d.ranges.length = 0;
    await parsePdfSegments({ ...d.input, parserProfile: profile });
    expect(d.ranges).toEqual([]);
  });

  it("defaults to ten physical pages and only retries failed segments after a new invocation", async () => {
    const d = setup();
    d.failures.add(11);
    await expect(parsePdfSegments(d.input)).rejects.toThrow("11-20");
    expect(d.ranges).toEqual([[1, 10], [11, 20], [21, 23]]);
    expect([...d.data.values()].map(s => s.state)).toEqual(["ready", "failed", "ready"]);
    d.failures.clear();
    d.ranges.length = 0;
    const pages = await parsePdfSegments({ ...d.input, scope: { ...scope, jobExecution: { ...scope.jobExecution, id: "retry" } } });
    expect(d.ranges).toEqual([[11, 20]]);
    expect(pages.map(p => p.page)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("never reuses another source version or non-OCR profile", async () => {
    const d = setup(2);
    await parsePdfSegments(d.input);
    await parsePdfSegments({ ...d.input, sourceVersion: 2 });
    await parsePdfSegments({ ...d.input, parserProfile: "ocr-v1" });
    expect(d.ranges).toHaveLength(3);
  });

  it("cancellation during inference cannot save or start more segments", async () => {
    const d = setup();
    d.input.runner = async (argv, _signal, stream) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":23}' };
      d.controller.abort();
      await stream!.onLine(JSON.stringify({ range: [1, 10], pages: [] }));
      return { exitCode: 0, stdout: "" };
    };
    await expect(parsePdfSegments(d.input)).rejects.toMatchObject({ name: "AbortError" });
    expect(d.segments.save).not.toHaveBeenCalled();
  });

  it("an atomic cache fence rejection is not turned into a retryable failed segment", async () => {
    const d = setup();
    d.segments.save = vi.fn(async () => { throw Object.assign(new Error("cancel won"), { code: "CONFLICT" }); });
    await expect(parsePdfSegments(d.input)).rejects.toThrow("cancel won");
    expect(d.segments.save).toHaveBeenCalledOnce();
    expect(d.ranges).toHaveLength(1);
  });

  it("starts just one converter for seven default ten-page ranges", async () => {
    const d = setup(70);
    expect(await parsePdfSegments(d.input)).toHaveLength(70);
    expect(d.batches).toEqual(["1-10,11-20,21-30,31-40,41-50,51-60,61-70"]);
    expect(d.segments.read).toHaveBeenCalledTimes(7);
    expect(d.segments.save).toHaveBeenCalledTimes(7);
    expect(vi.mocked(d.segments.read).mock.invocationCallOrder.at(-1))
      .toBeLessThan(vi.mocked(d.segments.save).mock.invocationCallOrder[0]!);
  });

  it.each([
    "not json",
    JSON.stringify({ range: [11, 12], pages: [] }),
    JSON.stringify({ range: [1, 10], pages: [{ page: 1, text: "missing", imagePath: null }] }),
    JSON.stringify({ range: [1, 10], error: "unknown" }),
    JSON.stringify({ range: [1, 10], error: ["timeout"] }),
    JSON.stringify({ range: [1, 10], error: "timeout", pages: [] }),
  ])("rejects bad stream rows without publishing or inventing failed cache entries: %s", async line => {
    const d = setup(12);
    d.input.runner = async (argv, _signal, stream) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":12}' };
      await stream!.onLine(line);
      return { exitCode: 0, stdout: "" };
    };
    await expect(parsePdfSegments(d.input)).rejects.toThrow();
    expect(d.segments.save).not.toHaveBeenCalled();
  });

  it.each(["missing", "crash", "timeout", "duplicate"])("retains successful cache on %s, no automatic replay, next invocation requests only the missing range", async mode => {
    const d = setup(12);
    const original = d.input.runner;
    d.input.runner = async (argv, _signal, stream) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":12}' };
      d.batches.push(argv[argv.indexOf("--ranges") + 1]!);
      const line = JSON.stringify({ range: [1, 10], pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: "ok", imagePath: null })) });
      await stream!.onLine(line);
      expect([...d.data.values()]).toHaveLength(1); // persisted before process ends
      if (mode === "crash") throw new Error("child crashed");
      if (mode === "duplicate") await stream!.onLine(line);
      if (mode === "timeout") await stream!.onLine(JSON.stringify({ range: [11, 12], error: "timeout" }));
      return { exitCode: mode === "timeout" ? 4 : 0, stdout: "" };
    };
    await expect(parsePdfSegments(d.input)).rejects.toThrow();
    expect(d.batches).toEqual(["1-10,11-12"]);
    expect([...d.data.values()][0]?.state).toBe("ready");
    d.input.runner = original;
    d.batches.length = 0;
    expect(await parsePdfSegments(d.input)).toHaveLength(12);
    expect(d.batches).toEqual(["11-12"]);
  });

  it("does not swallow a failed-row DB fence rejection or continue processing", async () => {
    const d = setup();
    d.failures.add(1);
    const conflict = Object.assign(new Error("privacy epoch changed"), { code: "CONFLICT" });
    d.segments.save = vi.fn(async () => { throw conflict; });
    await expect(parsePdfSegments(d.input)).rejects.toBe(conflict);
    expect(d.ranges).toEqual([[1, 10]]);
    expect(d.segments.save).toHaveBeenCalledOnce();
  });

  it("includes startup plus every missing-range timeout in the bounded outer budget", async () => {
    const d = setup(70);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await parsePdfSegments(d.input);
      expect(timeout).toHaveBeenCalledWith(120_000 + 7 * 240_000);
    } finally { timeout.mockRestore(); }
  });

  it("an outer timeout stops the batch, retains its committed cache and does not replay any range", async () => {
    const d = setup(12);
    const expired = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      return ms === 30_000 ? new AbortController().signal : expired.signal;
    });
    let conversions = 0;
    d.input.runner = async (argv, deadline, stream) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":12}' };
      conversions++;
      await stream!.onLine(JSON.stringify({ range: [1, 10], pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: "ok", imagePath: null })) }));
      expired.abort(new DOMException("batch timed out", "TimeoutError"));
      deadline.throwIfAborted();
      return { exitCode: 0, stdout: "" };
    };
    try {
      await expect(parsePdfSegments(d.input)).rejects.toMatchObject({ name: "TimeoutError" });
      expect(conversions).toBe(1);
      expect([...d.data.values()].map(value => value.state)).toEqual(["ready"]);
      expect(d.segments.save).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); }
  });

  it("polls execution serially and fails closed on revoked lease/privacy or unavailable DB", async () => {
    let calls = 0;
    const execution = await watchPdfExecution(async () => {
      calls++;
      if (calls === 2) throw new Error("lease lost");
    }, 5);
    try {
      await new Promise<void>(resolve => {
        const keepAlive = setTimeout(resolve, 500);
        execution.signal.addEventListener("abort", () => { clearTimeout(keepAlive); resolve(); }, { once: true });
      });
      expect(execution.signal.aborted).toBe(true);
      expect(execution.signal.reason.message).toBe("lease lost");
      expect(calls).toBe(2);
    } finally { await execution.stop(); }
  });
});
