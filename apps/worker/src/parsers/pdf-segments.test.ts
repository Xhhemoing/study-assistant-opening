import { describe, expect, it, vi } from "vitest";
import type { OpeningPdfSegmentsRepository, PdfSegment, PdfSegmentIdentity, PdfSegmentPage } from "@aistudy/database";
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
  const runner: ParserRunner = vi.fn(async argv => {
    if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: total }) };
    const start = Number(argv[argv.indexOf("--page-start") + 1]);
    const end = Number(argv[argv.indexOf("--page-end") + 1]);
    ranges.push([start, end]);
    return failures.has(start) ? { exitCode: 4, stdout: "" } : { exitCode: 0,
      stdout: JSON.stringify({ pages: Array.from({ length: end - start + 1 }, (_, index) => ({ page: start + index, text: `page ${start + index}`, imagePath: null })) }) };
  });
  const controller = new AbortController();
  const input = { path: "/document", sourceId: "source", sourceVersion: 0, scope, runner, segments, signal: controller.signal, parserProfile: "text-v1" };
  return { input, ranges, failures, data, controller, segments };
}

async function collectPdfSegments(input: Omit<Parameters<typeof parsePdfSegments>[0], "onPages">) {
  const pages: PdfSegmentPage[] = [];
  const result = await parsePdfSegments({ ...input, onPages: batch => { pages.push(...batch); } });
  expect(result.pageCount).toBe(pages.length);
  return Object.assign(pages, { failedRanges: result.failedRanges });
}

describe("bounded resumable PDF parser", () => {
  it("passes initial source version zero unchanged through cache read/save and reuses it", async () => {
    const d = setup(2);
    const first = await collectPdfSegments(d.input);
    expect(d.segments.read).toHaveBeenCalledWith(scope, expect.objectContaining({ sourceVersion: 0 }));
    expect(d.segments.save).toHaveBeenCalledWith(scope, expect.objectContaining({ sourceVersion: 0 }),
      { state: "ready", pages: [...first] }, d.input.signal);
    d.ranges.length = 0;
    expect(await collectPdfSegments(d.input)).toEqual(first);
    expect(d.ranges).toEqual([]);
  });

  it("does not reuse visual metadata cached before native cell provenance was retained", async () => {
    const d = setup(2);
    const legacyProfile = "docling-2.126.0/pdf-segments-v3-visual/text";
    await collectPdfSegments({ ...d.input, parserProfile: legacyProfile });
    const profile = pdfParserProfile({});
    expect(profile).not.toBe(legacyProfile);
    d.ranges.length = 0;
    await collectPdfSegments({ ...d.input, parserProfile: profile });
    expect(d.ranges).toEqual([[1, 2]]);
    d.ranges.length = 0;
    await collectPdfSegments({ ...d.input, parserProfile: profile });
    expect(d.ranges).toEqual([]);
  });

  it("keeps visual categories through durable cache reuse without re-running native extraction", async () => {
    const d = setup(1);
    const runner = d.input.runner;
    d.input.runner = async (argv, signal) => argv.includes("--inspect-pdf") ? runner(argv, signal)
      : {exitCode:0,stdout:JSON.stringify({pages:[{page:1,text:"caption",imagePath:null,visualKinds:["formula","picture"]}]})};
    expect((await collectPdfSegments(d.input))[0]).toMatchObject({visualKinds:["formula","picture"]});
    d.input.runner = runner;
    expect((await collectPdfSegments(d.input))[0]).toMatchObject({visualKinds:["formula","picture"]});
    expect(d.ranges).toEqual([]);
  });

  it("defaults to ten physical pages, retries a failed segment once, and reuses successes on a new invocation", async () => {
    const d = setup();
    d.failures.add(11);
    const partial = await collectPdfSegments(d.input);
    expect(partial.failedRanges).toEqual(["11-20"]);
    expect(d.ranges).toEqual([[1, 10], [11, 20], [11, 20], [21, 23]]);
    expect([...d.data.values()].map(s => s.state)).toEqual(["ready", "failed", "ready"]);
    d.failures.clear();
    d.ranges.length = 0;
    const pages = await collectPdfSegments({ ...d.input, scope: { ...scope, jobExecution: { ...scope.jobExecution, id: "retry" } } });
    expect(d.ranges).toEqual([[11, 20]]);
    expect(pages.map(p => p.page)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("assembles over 8 MiB of cached pages and resumes the missing tail in order", async () => {
    const d = setup(51);
    const text = "x".repeat(180_000);
    for (let start = 1; start <= 50; start += 10) {
      d.data.set(`source/0/text-v1/${start}-${start + 9}`, {
        state: "ready",
        pages: Array.from({ length: 10 }, (_, index) => ({ page: start + index, text, imagePath: null })),
      });
    }
    expect(Buffer.byteLength(text) * 50).toBeGreaterThan(8 * 1024 * 1024);

    const pages: PdfSegmentPage[] = [];
    const batches: number[][] = [];
    const result = await parsePdfSegments({ ...d.input, onPages: async batch => {
      // Cached batches are consumed before the missing tail starts parsing.
      await Promise.resolve();
      if (batch[0]?.page !== 51) expect(d.ranges).toEqual([]);
      batches.push(batch.map(page => page.page));
      pages.push(...batch);
    } });

    expect(batches.map(batch => batch.length)).toEqual([10, 10, 10, 10, 10, 1]);
    expect(d.ranges).toEqual([[51, 51]]);
    expect(pages.map(page => page.page)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
    expect(pages.slice(0, 50).every(page => page.text === text)).toBe(true);
    expect(pages.at(-1)?.text).toBe("page 51");
    expect(result).toEqual({ pageCount: 51, failedRanges: [] });
    expect(d.data.get("source/0/text-v1/51-51")).toMatchObject({ state: "ready" });
  });

  it("recovers a transient segment failure within the same invocation", async () => {
    const d = setup(1), original = d.input.runner;
    d.failures.add(1);
    d.input.runner = async (argv, signal) => {
      const result = await original(argv, signal);
      if (!argv.includes("--inspect-pdf")) d.failures.clear();
      return result;
    };
    const result = await collectPdfSegments(d.input);
    expect(result.map(p => p.page)).toEqual([1]);
    expect(result.failedRanges).toEqual([]);
    expect(d.ranges).toEqual([[1, 1], [1, 1]]);
    expect([...d.data.values()].map(s => s.state)).toEqual(["ready"]);
  });

  it("never reuses another source version or non-OCR profile", async () => {
    const d = setup(2);
    await collectPdfSegments(d.input);
    await collectPdfSegments({ ...d.input, sourceVersion: 2 });
    await collectPdfSegments({ ...d.input, parserProfile: "ocr-v1" });
    expect(d.ranges).toHaveLength(3);
  });

  it("cancellation during inference does not save ready or failed pages or start more segments", async () => {
    const d = setup();
    const original = d.input.runner;
    d.input.runner = async (argv, signal) => {
      const value = await original(argv, signal);
      if (!argv.includes("--inspect-pdf")) d.controller.abort();
      return value; // even a runner that ignores abort cannot publish its result
    };
    await expect(collectPdfSegments(d.input)).rejects.toMatchObject({ name: "AbortError" });
    expect(d.ranges).toHaveLength(1);
    expect(d.segments.save).not.toHaveBeenCalled();
  });

  it("an atomic cache fence rejection is not turned into a retryable failed segment", async () => {
    const d = setup();
    d.segments.save = vi.fn(async () => { throw Object.assign(new Error("cancel won"), { code: "CONFLICT" }); });
    await expect(collectPdfSegments(d.input)).rejects.toThrow("cancel won");
    expect(d.segments.save).toHaveBeenCalledOnce();
    expect(d.ranges).toHaveLength(1);
  });

  it("rejects incomplete/rebased segment output without publishing partial pages", async () => {
    const d = setup(12);
    d.input.runner = async argv => ({ exitCode: 0, stdout: JSON.stringify(argv.includes("--inspect-pdf") ? { pageCount: 12 }
      : { pages: [{ page: 1, text: "incomplete", imagePath: null }] }) });
    await expect(collectPdfSegments(d.input)).rejects.toThrow("1-10, 11-12");
    expect([...d.data.values()]).toEqual([{ state: "failed", errorCode: "invalid_output" }, { state: "failed", errorCode: "invalid_output" }]);
  });

  it("enforces an outer timeout, saves only the timeout failure and continues with the next segment", async () => {
    const d = setup(11);
    const original = d.input.runner;
    d.input.runner = async (argv, signal) => {
      if (argv.includes("--page-start") && argv[argv.indexOf("--page-start") + 1] === "1") {
        return new Promise((_resolve, reject) => {
          const hold = setTimeout(() => reject(new Error("deadline did not fire")), 1000);
          signal.addEventListener("abort", () => { clearTimeout(hold); reject(signal.reason); }, { once: true });
        });
      }
      return original(argv, signal);
    };
    const partial = await collectPdfSegments({ ...d.input, timeoutSeconds: 0.02 });
    expect(partial.failedRanges).toEqual(["1-10"]);
    expect([...d.data.values()].map(s => s.state === "failed" ? s.errorCode : s.state)).toEqual(["timeout", "ready"]);
  });

  it("passes the configured OCR segment deadline to the parser", async () => {
    const d = setup(1);
    await collectPdfSegments({ ...d.input, timeoutSeconds: 900 });
    expect(d.input.runner).toHaveBeenLastCalledWith(expect.arrayContaining(["--timeout-seconds", "900"]), expect.any(AbortSignal));
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
