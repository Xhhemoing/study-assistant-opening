import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { NewSourceChunk, OpeningJobRecord, OpeningPdfSegmentsRepository, PdfSegment, PdfSegmentIdentity, PdfSegmentPage } from "@aistudy/database";
import { createParseSourceHandler, sealTextWithState, type ParseSourceVisualPageInput, type ParseSourceVisualPageResult } from "../jobs/parse-source";
import { BoundsExceededError, decodeParserOutput } from "./docling-process";
import { MAX_PDF_BOOK_PAGES, parsePdfSegments, watchPdfExecution, type PdfSegmentBatch } from "./pdf-segments";
import { pdfParserProfile } from "./ocr-health";
import type { ParserRunner, VisualPageKind } from "./types";

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

  it("streams a 600-page dense textbook beyond 8 MiB cumulative text without hitting the old per-segment cap", async () => {
    const total = 600;
    const pageText = "Linear algebra proof step. ".repeat(700); // ~18.9 KB/page -> ~11.3 MB total (> 8 MiB!), ~189 KB/segment
    expect(Buffer.byteLength(pageText, "utf8") * total).toBeGreaterThan(10 * 1024 * 1024);
    const d = setup(total);
    d.input.runner = async (argv) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: total }) };
      const start = Number(argv[argv.indexOf("--page-start") + 1]);
      const end = Number(argv[argv.indexOf("--page-end") + 1]);
      d.ranges.push([start, end]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          pages: Array.from({ length: end - start + 1 }, (_, i) => ({ page: start + i, text: pageText, imagePath: null })),
        }),
      };
    };

    const segmentsSeen: PdfSegmentBatch[] = [];
    let consumedPages = 0;
    const result = await parsePdfSegments({
      ...d.input,
      onSegment: (segment) => {
        segmentsSeen.push({ ...segment, pages: [] });
        consumedPages += segment.pages.length;
      },
    });
    expect(result).toEqual({ pageCount: total, failedRanges: [] });
    expect(consumedPages).toBe(total);
    expect(segmentsSeen).toHaveLength(60);
    expect(segmentsSeen.every(s => s.segmentBytes <= 8 * 1024 * 1024)).toBe(true);
  });

  it("enforces per-segment, per-page, whole-book byte caps and MAX_PDF_BOOK_PAGES with BoundsExceededError", async () => {
    const oversizedPage = setup(1);
    oversizedPage.input.runner = async (argv) => argv.includes("--inspect-pdf")
      ? { exitCode: 0, stdout: '{"pageCount":1}' }
      : { exitCode: 0, stdout: JSON.stringify({ pages: [{ page: 1, text: "a".repeat(20_000), imagePath: null }] }) };
    await expect(parsePdfSegments({ ...oversizedPage.input, maxPageTextBytes: 10_000, onPages: () => {} }))
      .rejects.toBeInstanceOf(BoundsExceededError);
    expect(oversizedPage.segments.save).not.toHaveBeenCalled();

    const oversizedSegment = setup(10);
    oversizedSegment.input.runner = async (argv) => argv.includes("--inspect-pdf")
      ? { exitCode: 0, stdout: '{"pageCount":10}' }
      : {
        exitCode: 0,
        stdout: JSON.stringify({
          pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: "b".repeat(1500), imagePath: null })),
        }),
      };
    await expect(parsePdfSegments({ ...oversizedSegment.input, maxSegmentBytes: 10_000, onPages: () => {} }))
      .rejects.toBeInstanceOf(BoundsExceededError);

    const oversizedBook = setup(30);
    oversizedBook.input.runner = async (argv) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":30}' };
      const start = Number(argv[argv.indexOf("--page-start") + 1]);
      const end = Number(argv[argv.indexOf("--page-end") + 1]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          pages: Array.from({ length: end - start + 1 }, (_, i) => ({ page: start + i, text: "c".repeat(1000), imagePath: null })),
        }),
      };
    };
    const seen: number[] = [];
    await expect(parsePdfSegments({ ...oversizedBook.input, maxBookBytes: 25_000, onPages: pages => { seen.push(...pages.map(p => p.page)); } }))
      .rejects.toBeInstanceOf(BoundsExceededError);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const tooManyPages = setup(MAX_PDF_BOOK_PAGES + 1);
    await expect(collectPdfSegments(tooManyPages.input)).rejects.toBeInstanceOf(BoundsExceededError);

    const maxBook = setup(MAX_PDF_BOOK_PAGES);
    const smallDense = "Theorem and proof step. ".repeat(220); // ~5.5 KB/page -> ~11 MB across 2,000 pages (> 8 MiB, < 64 MiB)
    maxBook.input.runner = async (argv) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: MAX_PDF_BOOK_PAGES }) };
      const start = Number(argv[argv.indexOf("--page-start") + 1]);
      const end = Number(argv[argv.indexOf("--page-end") + 1]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          pages: Array.from({ length: end - start + 1 }, (_, i) => ({ page: start + i, text: smallDense, imagePath: null })),
        }),
      };
    };
    const fullBookResult = await parsePdfSegments({ ...maxBook.input, onPages: () => {} });
    expect(fullBookResult).toEqual({ pageCount: MAX_PDF_BOOK_PAGES, failedRanges: [] });
  });

  it("seals same-page solution_sealed answer keys before public chunk staging and skips vision on all-sealed pages", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-seal-test-"));
    try {
      const pdfBytes = Buffer.from("pdf-payload");
      const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
      const sourceRecord: SourceRecord = {
        id: "00000000-0000-4000-8000-000000000011",
        workspaceId: "00000000-0000-4000-8000-000000000012",
        name: "exercises.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.byteLength,
        sha256,
        version: 0,
        uploadState: "uploaded",
        parseState: "queued",
        error: null,
        createdAt: new Date().toISOString(),
      };
      const jobRecord = {
        id: "00000000-0000-4000-8000-000000000013",
        workspaceId: sourceRecord.workspaceId,
        ownerUserId: "00000000-0000-4000-8000-000000000014",
        key: "parse-seal-test",
        kind: "parse",
        payload: { sourceId: sourceRecord.id, sourceVersion: 0 },
        result: null,
        state: "running",
        claimToken: "claim-1",
        privacyEpoch: 0,
      } as OpeningJobRecord;

      const publishedChunks: NewSourceChunk[] = [];
      const recognizePage = vi.fn(async () => ({ text: "SHOULD_NOT_RUN", imageObjectKey: "bad" }));
      const handler = createParseSourceHandler({
        sources: { get: async () => sourceRecord, markParseState: async () => sourceRecord },
        chunks: {
          replaceChunks: async () => { throw new Error("expected replacePdfChunks"); },
          replacePdfChunks: async (_scope, publication) => {
            for await (const chunk of publication.chunks) publishedChunks.push(chunk);
          },
          listChunksAtVersion: async () => [],
        },
        storage: {
          finalKey: () => "sources/test/0/original",
          presignGet: async () => `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
        },
        runner: async (argv) => argv.includes("--inspect-pdf")
          ? { exitCode: 0, stdout: '{"pageCount":2}' }
          : {
            exitCode: 0,
            stdout: JSON.stringify({
              pages: [
                {
                  page: 1,
                  text: "Exercise 1: Solve x + 2 = 5.\nAnswer Key: x = 3.\nExercise 2: Solve y * 2 = 8.\n参考答案：y = 4。",
                  imagePath: null,
                  visualKinds: [],
                },
                {
                  page: 2,
                  text: "参考答案\n1. x = 3\n2. y = 4",
                  imagePath: null,
                },
              ],
            }),
          },
        tempDir,
        segments: { assertCurrent: async () => {}, read: async () => null, save: async () => {} },
        recognizePage,
      });

      await expect(handler(jobRecord, { sourceId: sourceRecord.id, sourceVersion: 0 })).resolves.toEqual({ pages: 2 });
      expect(recognizePage).not.toHaveBeenCalled();
      expect(publishedChunks).toHaveLength(1);
      expect(publishedChunks[0]).toMatchObject({
        page: 1,
        text: "Exercise 1: Solve x + 2 = 5.\nExercise 2: Solve y * 2 = 8.",
        imageObjectKey: null,
      });
      expect(publishedChunks[0]!.text).not.toContain("Answer Key");
      expect(publishedChunks[0]!.text).not.toContain("x = 3");
      expect(publishedChunks[0]!.text).not.toContain("y = 4");
      expect(await readdir(tempDir)).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails fast with BoundsExceededError on 210k-char pages without retrying or saving invalid_output", async () => {
    const d = setup(1);
    const runner = vi.fn<ParserRunner>(async (argv) => argv.includes("--inspect-pdf")
      ? { exitCode: 0, stdout: '{"pageCount":1}' }
      : { exitCode: 0, stdout: JSON.stringify({ pages: [{ page: 1, text: "x".repeat(210_000), imagePath: null }] }) });
    d.input.runner = runner;
    await expect(collectPdfSegments(d.input)).rejects.toBeInstanceOf(BoundsExceededError);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(d.segments.save).not.toHaveBeenCalled();
  });

  it("seals scanned Vision answer transcriptions, stale saved chunks, and cross-segment 10->11 answer keys while keeping prose and worked examples", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-round2-seal-"));
    try {
      const pdfBytes = Buffer.from("pdf-payload-r2");
      const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
      const sourceRecord: SourceRecord = {
        id: "00000000-0000-4000-8000-000000000021",
        workspaceId: "00000000-0000-4000-8000-000000000022",
        name: "textbook.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.byteLength,
        sha256,
        version: 0,
        uploadState: "uploaded",
        parseState: "queued",
        error: null,
        createdAt: new Date().toISOString(),
      };
      const jobRecord = {
        id: "00000000-0000-4000-8000-000000000023",
        workspaceId: sourceRecord.workspaceId,
        ownerUserId: "00000000-0000-4000-8000-000000000024",
        key: "parse-r2-test",
        kind: "parse",
        payload: { sourceId: sourceRecord.id, sourceVersion: 0 },
        result: null,
        state: "running",
        claimToken: "claim-r2",
        privacyEpoch: 0,
      } as OpeningJobRecord;

      const pages: PdfSegmentPage[] = [
        // Page 1: wrapped prose with "solution." + chemistry Solutions + worked example with Solution: + Exercise with stale saved answer key
        {
          page: 1,
          text: "Theorem 2.1: Ax = b has a unique\nsolution. Moreover, x = A^{-1}b.\n\n## Solutions\nA homogeneous mixture.\n\nExample 1: Compute d/dx(x^2).\nSolution: By the power rule, 2x.",
          imagePath: null,
          visualKinds: [],
        },
        // Page 2: scanned page where Vision returns Answer Key -> must be sealed and NOT published
        { page: 2, text: "", imagePath: null, visualKinds: ["scan"] },
        // Page 3: stale saved chunk with Answer Key + public Exercise
        { page: 3, text: "Exercise 3: Find y.\nAnswer Key: y = 9.", imagePath: null, visualKinds: [] },
        // Page 4..9: public prose
        ...Array.from({ length: 6 }, (_, i) => ({ page: 4 + i, text: `Chapter 1 prose page ${4 + i}.`, imagePath: null, visualKinds: [] as [] })),
        // Page 10: all-sealed Answer Key stripped to empty by physical_pages.py (visualKinds: [])
        { page: 10, text: "", imagePath: null, visualKinds: [] },
        // Page 11 (next 10-page segment): unheaded numbered answer items continuing from page 10
        { page: 11, text: "11. x = 3\n12. y = 4", imagePath: null, visualKinds: [] },
        // Page 12: Bibliography ends section_sealed
        { page: 12, text: "Bibliography\n[1] Knuth.", imagePath: null, visualKinds: [] },
      ];

      const publishedChunks: NewSourceChunk[] = [];
      const recognizePage = vi.fn(async ({ physicalPage }: { physicalPage: number }) => {
        if (physicalPage === 2) return { text: "Answers to Selected Exercises\n1.1 x = 3\n1.2 y = 4\nEnd of Answers.", imageObjectKey: "vision/p2-secret" };
        throw new Error(`unexpected vision call on page ${physicalPage}`);
      });

      const handler = createParseSourceHandler({
        sources: { get: async () => sourceRecord, markParseState: async () => sourceRecord },
        chunks: {
          replaceChunks: async () => { throw new Error("expected replacePdfChunks"); },
          replacePdfChunks: async (_scope, publication) => {
            for await (const chunk of publication.chunks) publishedChunks.push(chunk);
          },
          listChunksAtVersion: async (_scope, _sid, _ver, pageNums) => {
            if (pageNums?.includes(3)) {
              return [{
                id: "00000000-0000-4000-8000-000000000099",
                sourceId: sourceRecord.id,
                sourceVersion: 0,
                page: 3,
                slideLabel: null,
                startMs: null,
                endMs: null,
                text: "Exercise 3: Find y.\nAnswer Key: y = 9.",
                imageObjectKey: null,
              }];
            }
            return [];
          },
        },
        storage: {
          finalKey: () => "sources/test/0/original",
          presignGet: async () => `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
        },
        runner: async (argv) => {
          if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: 12 }) };
          const start = Number(argv[argv.indexOf("--page-start") + 1]);
          const end = Number(argv[argv.indexOf("--page-end") + 1]);
          return { exitCode: 0, stdout: JSON.stringify({ pages: pages.slice(start - 1, end) }) };
        },
        tempDir,
        segments: { assertCurrent: async () => {}, read: async () => null, save: async () => {} },
        recognizePage,
      });

      await expect(handler(jobRecord, { sourceId: sourceRecord.id, sourceVersion: 0 })).resolves.toEqual({ pages: 12 });
      expect(recognizePage).toHaveBeenCalledTimes(1);
      expect(publishedChunks.map(c => c.page)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 12]);
      expect(publishedChunks[0]!.text).toContain("unique\nsolution. Moreover");
      expect(publishedChunks[0]!.text).toContain("homogeneous mixture");
      expect(publishedChunks[0]!.text).toContain("By the power rule, 2x.");
      expect(publishedChunks[1]!.text).toBe("Exercise 3: Find y.");
      expect(publishedChunks.find(c => c.page === 2)).toBeUndefined();
      expect(publishedChunks.find(c => c.page === 10)).toBeUndefined();
      expect(publishedChunks.find(c => c.page === 11)).toBeUndefined();
      expect(publishedChunks.at(-1)!.text).toContain("Bibliography");
      expect(await readdir(tempDir)).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles astral math symbols (𝑥) safely while sealing PPTX and PDF pages", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-astral-seal-"));
    try {
      const pdfBytes = Buffer.from("pptx-astral");
      const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
      const pptxSource: SourceRecord = {
        id: "00000000-0000-4000-8000-000000000031",
        workspaceId: "00000000-0000-4000-8000-000000000032",
        name: "astral.pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: pdfBytes.byteLength,
        sha256,
        version: 0,
        uploadState: "uploaded",
        parseState: "queued",
        error: null,
        createdAt: new Date().toISOString(),
      };
      const jobRecord = {
        id: "00000000-0000-4000-8000-000000000033",
        workspaceId: pptxSource.workspaceId,
        ownerUserId: "00000000-0000-4000-8000-000000000034",
        key: "parse-astral-test",
        kind: "parse",
        payload: { sourceId: pptxSource.id, sourceVersion: 0 },
        result: null,
        state: "running",
        claimToken: "claim-astral",
        privacyEpoch: 0,
      } as OpeningJobRecord;

      const publishedChunks: NewSourceChunk[] = [];
      const rawText = "Exercise 1: Compute 𝑥 + 1.\nAnswer Key: 𝑥 = 2.\n\nTheorem 1: 𝑥 ∈ ℝ.";
      const pptxHandler = createParseSourceHandler({
        sources: { get: async () => pptxSource, markParseState: async () => pptxSource },
        chunks: {
          replaceChunks: async (_scope, publication) => { publishedChunks.push(...publication.chunks); },
          replacePdfChunks: async () => {},
          listChunksAtVersion: async () => [],
        },
        storage: {
          finalKey: () => "sources/test/0/original",
          presignGet: async () => `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${pdfBytes.toString("base64")}`,
        },
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ pages: [{ page: 1, text: rawText, imagePath: null }] }),
        }),
        tempDir,
      });

      await pptxHandler(jobRecord, { sourceId: pptxSource.id, sourceVersion: 0 });
      expect(publishedChunks).toHaveLength(1);
      expect(publishedChunks[0]?.text).toBe("Exercise 1: Compute 𝑥 + 1.\nTheorem 1: 𝑥 ∈ ℝ.");
      expect(publishedChunks[0]?.text).not.toContain("Answer Key");
      expect(publishedChunks[0]?.text).not.toContain("𝑥 = 2");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function runPdfScenario(options: {
    pages: Array<{
      page: number;
      text: string;
      visualKinds?: VisualPageKind[];
      discourseBlocks?: Array<Record<string, unknown>>;
      sectionSealedAtEnd?: boolean;
      hadSealedContent?: boolean;
    }>;
    savedChunks?: NewSourceChunk[];
    recognizePages?: (
      inputs: readonly ParseSourceVisualPageInput[],
    ) => AsyncGenerator<ParseSourceVisualPageResult | null, void, void>;
  }) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-r3-"));
    try {
      const pdfBytes = Buffer.from("%PDF-1.4\n% round3\n");
      const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
      const pdfSource: SourceRecord = {
        id: "00000000-0000-4000-8000-000000000041",
        workspaceId: "00000000-0000-4000-8000-000000000042",
        name: "round3.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.byteLength,
        sha256,
        version: 0,
        uploadState: "uploaded",
        parseState: "queued",
        error: null,
        createdAt: new Date().toISOString(),
      };
      const jobRecord = {
        id: "00000000-0000-4000-8000-000000000043",
        workspaceId: pdfSource.workspaceId,
        ownerUserId: "00000000-0000-4000-8000-000000000044",
        key: "parse-pdf-r3",
        kind: "parse",
        payload: { sourceId: pdfSource.id, sourceVersion: 0 },
        result: null,
        state: "running",
        claimToken: "claim-r3",
        privacyEpoch: 0,
      } as OpeningJobRecord;

      const publishedChunks: NewSourceChunk[] = [];
      let preservePages: number[] = [];
      let pdfWarning: unknown = undefined;
      const savedMap = new Map((options.savedChunks ?? []).map(chunk => [chunk.page, chunk]));
      const segmentData = new Map<string, PdfSegment>();
      const segments: OpeningPdfSegmentsRepository = {
        assertCurrent: async () => {},
        read: async (_scope, identity) => segmentData.get(`${identity.pageStart}-${identity.pageEnd}`) ?? null,
        save: async (_scope, identity, value) => { segmentData.set(`${identity.pageStart}-${identity.pageEnd}`, value); },
      };

      const handler = createParseSourceHandler({
        sources: { get: async () => pdfSource, markParseState: async () => pdfSource },
        chunks: {
          replaceChunks: async () => {},
          replacePdfChunks: async (_scope, publication) => {
            for await (const chunk of publication.chunks) publishedChunks.push(chunk);
            preservePages = publication.preservePages;
            pdfWarning = publication.warning;
          },
          listChunksAtVersion: async (_scope, _sourceId, _sourceVersion, pageNumbers) =>
            pageNumbers.flatMap(page => {
              const saved = savedMap.get(page);
              return saved ? [{ ...saved, sourceId: pdfSource.id, sourceVersion: 0, workspaceId: pdfSource.workspaceId, id: `chunk-${page}`, createdAt: new Date().toISOString() }] : [];
            }),
        },
        segments,
        storage: {
          finalKey: () => "sources/test/0/original",
          presignGet: async () => `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
        },
        runner: async argv => {
          if (argv.includes("--inspect-pdf")) {
            return { exitCode: 0, stdout: JSON.stringify({ pageCount: options.pages.length }) };
          }
          const start = Number(argv[argv.indexOf("--page-start") + 1]);
          const end = Number(argv[argv.indexOf("--page-end") + 1]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              pages: options.pages
                .filter(p => p.page >= start && p.page <= end)
                .map(p => ({ page: p.page, text: p.text, imagePath: null, visualKinds: p.visualKinds ?? [], ...(p.discourseBlocks ? { discourseBlocks: p.discourseBlocks } : {}), ...(p.sectionSealedAtEnd !== undefined ? { sectionSealedAtEnd: p.sectionSealedAtEnd } : {}), ...(p.hadSealedContent !== undefined ? { hadSealedContent: p.hadSealedContent } : {}) })),
            }),
          };
        },
        ...(options.recognizePages
          ? { recognizePages: inputs => options.recognizePages!(inputs) }
          : {}),
        assertCurrent: async () => {},
        tempDir,
      });

      const outcome = await handler(jobRecord, { sourceId: pdfSource.id, sourceVersion: 0 });
      return { outcome, publishedChunks, preservePages, pdfWarning };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  it("preserves standalone worked-example solutions and exits section sealing on non-answer headings and chapters", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        { page: 1, text: "Example 1: Compute x + 1.\n\n解答：\nx = 2.\n\n**ANSWERS TO SELECTED EXERCISES**\n1. x = 3" },
        { page: 2, text: "2. y = 4\nChapter 2: Vector Spaces\nDefinition 2.1: Closure under addition." },
        { page: 3, text: "**练习答案**：\n1. 对\n第二章 微积分\n定理 2.1：极限唯一。" },
        { page: 4, text: "**Answer**: x = 3\n## Next Topic\nPublic proof note." },
      ],
    });

    expect(publishedChunks.map(c => c.page)).toEqual([1, 2, 3, 4]);
    expect(publishedChunks[0]?.text).toBe("Example 1: Compute x + 1.\n\n解答：\nx = 2.");
    expect(publishedChunks[1]?.text).toBe("Chapter 2: Vector Spaces\nDefinition 2.1: Closure under addition.");
    expect(publishedChunks[2]?.text).toBe("第二章 微积分\n定理 2.1：极限唯一。");
    expect(publishedChunks[3]?.text).toBe("## Next Topic\nPublic proof note.");
  });

  it("treats docling-blank pages as soft continuations so Chapter 2 stays public while unheaded answers stay sealed", async () => {
    const titledChapterAfterBlank = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: [] },
        { page: 2, text: "Chapter 2: Vector Spaces\nLet V be a vector space.", visualKinds: [] },
      ],
    });
    expect(titledChapterAfterBlank.publishedChunks.map(c => c.page)).toEqual([2]);
    expect(titledChapterAfterBlank.publishedChunks[0]?.text).toBe("Chapter 2: Vector Spaces\nLet V be a vector space.");

    const unheadedAnswersAfterBlank = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: [] },
        { page: 2, text: "11. x = 3\n12. y = 4", visualKinds: [] },
        { page: 3, text: "Definition 3.1: Orthogonal basis.", visualKinds: [] },
      ],
    });
    expect(unheadedAnswersAfterBlank.publishedChunks.map(c => c.page)).toEqual([3]);
    expect(unheadedAnswersAfterBlank.publishedChunks[0]?.text).toBe("Definition 3.1: Orthogonal basis.");
  });

  it("propagates sealing state sequentially across Vision scan pages and does not count sealed mixed-page Vision as skipped", async () => {
    const sequentialScan = await runPdfScenario({
      pages: [
        { page: 1, text: "Exercises 1:\nFind x.", visualKinds: [] },
        { page: 2, text: "", visualKinds: ["scan"] },
        { page: 3, text: "", visualKinds: ["scan"] },
        { page: 4, text: "4. w = 4", visualKinds: [] },
        { page: 5, text: "Chapter 2: Vector Spaces\nPublic intro.", visualKinds: [] },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          if (input.physicalPage === 2) yield { text: "Answer Key\n1. x = 1", imageObjectKey: "img-2" };
          else if (input.physicalPage === 3) yield { text: "2. y = 2\n3. z = 3", imageObjectKey: "img-3" };
        }
      },
    });
    expect(sequentialScan.publishedChunks.map(c => c.page)).toEqual([1, 5]);
    expect(sequentialScan.outcome).toEqual({ pages: 5 });

    const mixedSealedVision = await runPdfScenario({
      pages: [
        { page: 1, text: "Theorem 1: Continuous functions on [a,b] are bounded.", visualKinds: ["picture"] },
      ],
      recognizePages: async function* () {
        yield { text: "Answer Key\n1. x = 2", imageObjectKey: "img-sealed" };
      },
    });
    expect(mixedSealedVision.outcome).toEqual({ pages: 1 });
    expect(mixedSealedVision.pdfWarning).toBeUndefined();
    expect(mixedSealedVision.publishedChunks).toHaveLength(1);
    expect(mixedSealedVision.publishedChunks[0]?.imageObjectKey).toBeNull();
    expect(mixedSealedVision.publishedChunks[0]?.text).toBe("Theorem 1: Continuous functions on [a,b] are bounded.");
  });

  it("sanitizes oversized stale saved chunks instead of keeping them in preservePages and strips rawCharStart/rawCharEnd spans", async () => {
    const oversizedPublic = "A".repeat(100_050);
    const staleSaved: NewSourceChunk = {
      page: 1,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: `${oversizedPublic}\nAnswer Key\n1. x = 2`,
      imageObjectKey: null,
    };
    const sanitized = await runPdfScenario({
      pages: [
        { page: 1, text: "Public fallback", visualKinds: [] },
      ],
      savedChunks: [staleSaved],
    });
    expect(sanitized.preservePages).toEqual([]);
    expect(sanitized.publishedChunks).toHaveLength(1);
    expect(sanitized.publishedChunks[0]?.text.length).toBe(100_000);
    expect(sanitized.publishedChunks[0]?.text).not.toContain("Answer Key");

    const rawSpanText = sealTextWithState(
      "Problem 1.\n\n𝑥 = 2.\nTheorem 1.",
      { mode: "none", inWorkedExample: false, afterAllSealedPage: false },
      1,
      [
        {
          kind: "solution_sealed",
          text: "𝑥 = 2.",
          pageNumber: 1,
          charStart: null,
          charEnd: null,
          rawCharStart: 12,
          rawCharEnd: 18,
          continuedFromPrevPage: false,
          continuesOnNextPage: false,
          visibilityHint: "sealed",
        },
      ],
    );
    expect(rawSpanText).toBe("Problem 1.\n\nTheorem 1.");
  });

  it("Round-4: promotes dotted items and bare chapters after docling-blank pages, handles multi-bold markdown, and keeps lowercase wrapped solution public", async () => {
    const dottedAfterBlank = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: [] },
        { page: 2, text: "1.1 x = 3\n1.2 y = 4", visualKinds: [] },
        { page: 3, text: "Chapter 2\n1. x = 3", visualKinds: [] },
        { page: 4, text: "第二章\n1. x = 3", visualKinds: [] },
        { page: 5, text: "Section 1.2\n1. x = 3", visualKinds: [] },
        { page: 6, text: "**Chapter 2**: **Vector Spaces**\nTheorem 2.1: Basis exists.", visualKinds: [] },
      ],
    });
    expect(dottedAfterBlank.publishedChunks.map(c => c.page)).toEqual([6]);
    expect(dottedAfterBlank.publishedChunks[0]?.text).toBe("**Chapter 2**: **Vector Spaces**\nTheorem 2.1: Basis exists.");

    const exerciseAfterBlank = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: [] },
        { page: 2, text: "Exercise 1: Compute x + 1.", visualKinds: [] },
      ],
    });
    expect(exerciseAfterBlank.publishedChunks.map(c => c.page)).toEqual([2]);

    const multiBoldAndCase = await runPdfScenario({
      pages: [
        { page: 1, text: "The equation has a unique\nsolution\nfor all x > 0.", visualKinds: [] },
        { page: 2, text: "Problem 1.\n**Answer**: **42**\n\n**课后答案**：**1. x = 3**", visualKinds: [] },
        { page: 3, text: "2. y = 4\n## Next Topic\nWorked Solution\nx = 2.", visualKinds: [] },
      ],
    });
    expect(multiBoldAndCase.publishedChunks.map(c => c.page)).toEqual([1, 2, 3]);
    expect(multiBoldAndCase.publishedChunks[0]?.text).toBe("The equation has a unique\nsolution\nfor all x > 0.");
    expect(multiBoldAndCase.publishedChunks[1]?.text).toBe("Problem 1.");
    expect(multiBoldAndCase.publishedChunks[2]?.text).toBe("## Next Topic");
  });

  it("Round-4: strips stale [视觉转写与描述] headers, redacts sealed imageObjectKey, preserves Vision sealState on reuse, and falls back to recognizePages", async () => {
    const staleVisionOnly = await runPdfScenario({
      pages: [
        { page: 1, text: "Exercises 1:\nSolve x.", visualKinds: [] },
        { page: 2, text: "", visualKinds: ["scan"] },
        { page: 3, text: "Theorem 1: Always true.", visualKinds: ["picture"] },
      ],
      savedChunks: [
        {
          page: 2,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\nAnswer Key\n1. x = 1",
          imageObjectKey: "vision/p2-secret",
        },
        {
          page: 3,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[原生提取]\nTheorem 1: Always true.\n\n[视觉转写与描述]\nAnswer Key\n2. y = 2",
          imageObjectKey: "vision/p3-secret",
        },
      ],
    });
    expect(staleVisionOnly.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(staleVisionOnly.publishedChunks[1]?.text).toBe("Theorem 1: Always true.");
    expect(staleVisionOnly.publishedChunks[1]?.imageObjectKey).toBeNull();

    const reusedWithAnswerKey = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "2. y = 2", visualKinds: [] },
        { page: 3, text: "Chapter 2: Vector Spaces\nIntro.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\nTheorem 1.\n\nAnswer Key\n1. x = 1",
          imageObjectKey: "vision/p1-public",
        },
      ],
    });
    expect(reusedWithAnswerKey.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(reusedWithAnswerKey.publishedChunks[0]?.text).toBe("[视觉转写与描述]\nTheorem 1.");
    expect(reusedWithAnswerKey.publishedChunks[0]?.imageObjectKey).toBeNull();

    const seenPages: number[] = [];
    const fallbackOnDynamicInvalidation = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "", visualKinds: ["scan"] },
      ],
      savedChunks: [
        {
          page: 2,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\n1. x = 1",
          imageObjectKey: "vision/stale-p2",
        },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          seenPages.push(input.physicalPage);
          if (input.physicalPage === 1) yield { text: "Answer Key\n0. x = 0", imageObjectKey: "img-1" };
          else if (input.physicalPage === 2) yield { text: "Chapter 2: Vector Spaces\nRecovered page 2.", imageObjectKey: "img-2" };
        }
      },
    });
    expect(seenPages).toEqual([1, 2]);
    expect(fallbackOnDynamicInvalidation.outcome).toEqual({ pages: 2 });
    expect(fallbackOnDynamicInvalidation.pdfWarning).toBeUndefined();
    expect(fallbackOnDynamicInvalidation.publishedChunks).toHaveLength(1);
    expect(fallbackOnDynamicInvalidation.publishedChunks[0]?.page).toBe(2);
    expect(fallbackOnDynamicInvalidation.publishedChunks[0]?.text).toContain("Recovered page 2.");
  });

  it("Round-5: preserves delimited Vision after trailing inline_sealed, keeps bold Section exits, and propagates savedSeal on degraded fallback", async () => {
    const inlineBeforeVision = await runPdfScenario({
      pages: [
        { page: 1, text: "Find the vertex.\nAnswer: (0, 0).", visualKinds: ["picture"] },
        { page: 2, text: "Theorem 1: Next theorem.", visualKinds: [] },
      ],
      recognizePages: async function* () {
        yield { text: "Chapter 2: Conic Sections\nA parabola opening upward.\nAnswer: (0, 0).", imageObjectKey: "vision/parabola" };
      },
    });
    expect(inlineBeforeVision.publishedChunks.map(c => c.page)).toEqual([1, 2]);
    expect(inlineBeforeVision.publishedChunks[0]?.imageObjectKey).toBeNull();
    expect(inlineBeforeVision.publishedChunks[0]?.text).toContain("A parabola opening upward.");

    const boldSectionAndSavedInline = await runPdfScenario({
      pages: [
        { page: 1, text: "Answer Key\n1. x = 1", visualKinds: [] },
        { page: 2, text: "**Section 1.2**: **Vector Spaces**\nDefinition 1.2: Closure.", visualKinds: [] },
        { page: 3, text: "Find the vertex.", visualKinds: ["picture"] },
      ],
      savedChunks: [
        {
          page: 3,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[原生提取]\nFind the vertex.\nAnswer: (0, 0).\n\n[视觉转写与描述]\nChapter 2: Conic Sections\nA parabola opening upward.\nAnswer: (0, 0).",
          imageObjectKey: "vision/saved-parabola",
        },
      ],
    });
    expect(boldSectionAndSavedInline.publishedChunks.map(c => c.page)).toEqual([2, 3]);
    expect(boldSectionAndSavedInline.publishedChunks[0]?.text).toBe("**Section 1.2**: **Vector Spaces**\nDefinition 1.2: Closure.");
    expect(boldSectionAndSavedInline.publishedChunks[1]?.imageObjectKey).toBeNull();
    expect(boldSectionAndSavedInline.publishedChunks[1]?.text).toContain("A parabola opening upward.");

    const degradedSavedVisionPropagation = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "3. z = 3", visualKinds: [] },
        { page: 3, text: "Chapter 2: Linear Maps\nIntro.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\nAnswer Key\n1. x = 1",
          imageObjectKey: "vision/secret-p1",
        },
      ],
      recognizePages: async function* () {
        yield null;
      },
    });
    expect(degradedSavedVisionPropagation.publishedChunks.map(c => c.page)).toEqual([3]);
    expect(degradedSavedVisionPropagation.publishedChunks[0]?.text).toBe("Chapter 2: Linear Maps\nIntro.");

    const degradedMixedRedaction = await runPdfScenario({
      pages: [
        { page: 1, text: "Theorem 1.", visualKinds: ["picture"] },
        { page: 2, text: "3. z = 3", visualKinds: [] },
        { page: 3, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[原生提取]\nTheorem 1.\n\n[视觉转写与描述]\nAnswer Key\n2. y = 2",
          imageObjectKey: "vision/secret-mixed",
        },
      ],
      recognizePages: async function* () {
        yield null;
      },
    });
    expect(degradedMixedRedaction.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(degradedMixedRedaction.publishedChunks[0]?.text).toBe("Theorem 1.");
    expect(degradedMixedRedaction.publishedChunks[0]?.imageObjectKey).toBeNull();
  });

  it("Round-6 [P1-1]: propagates sectionSealedAtEnd across a 10-page PDF segment boundary and roundtrips decodeParserOutput", async () => {
    const decoded = decodeParserOutput(JSON.stringify({
      pages: [
        { page: 10, text: "Public theorem.", imagePath: null, visualKinds: [], sectionSealedAtEnd: true },
        { page: 11, text: "Next page.", imagePath: null, visualKinds: [] },
      ],
    }));
    expect(decoded).toEqual([
      { page: 10, text: "Public theorem.", imagePath: null, visualKinds: [], sectionSealedAtEnd: true },
      { page: 11, text: "Next page.", imagePath: null, visualKinds: [] },
    ]);
    expect("sectionSealedAtEnd" in decoded[1]!).toBe(false);
    expect(() => decodeParserOutput(JSON.stringify({
      pages: [{ page: 1, text: "x", imagePath: null, sectionSealedAtEnd: "yes" }],
    }))).toThrow("invalid sectionSealedAtEnd metadata");

    const multiSegmentBoundary = await runPdfScenario({
      pages: [
        ...Array.from({ length: 9 }, (_, idx) => ({ page: idx + 1, text: `Topic ${idx + 1}.`, visualKinds: [] as VisualPageKind[] })),
        { page: 10, text: "Public theorem.", visualKinds: [], sectionSealedAtEnd: true },
        { page: 11, text: "2. y = 4", visualKinds: [] },
        { page: 12, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
    });
    expect(multiSegmentBoundary.outcome).toEqual({ pages: 12 });
    expect(multiSegmentBoundary.publishedChunks.map(c => c.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
    expect(multiSegmentBoundary.publishedChunks[9]?.text).toBe("Public theorem.");
    expect(multiSegmentBoundary.publishedChunks[10]?.text).toBe("Chapter 2: Rings\nDef.");
  });

  it("Round-6 [P1-2]: parses production Vision wrappers, redacts sealed descriptions/images, and keeps clean diagrams", async () => {
    const liveWrapped = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "", visualKinds: [] },
        { page: 3, text: "Chapter 1: Mechanics\nExercise 1.\nAnswer: x = 1.\n\nExercise 2: Plot the trajectory.", visualKinds: ["picture"] },
        { page: 4, text: "Chapter 2: Geometry\nDefinition of triangle.", visualKinds: ["picture"] },
        { page: 5, text: "", visualKinds: ["scan"] },
        { page: 6, text: "2. y = 4", visualKinds: [] },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          if (input.physicalPage === 1) {
            yield {
              text: "【原图忠实转写，尚需核对】\nAnswer Key\n1. x = 2\n\n【图表观察描述，非原文或解答】\nPrinted answer grid.\n\n【识别不确定，不能据此判定正确】\nMargin sketch.",
              imageObjectKey: "vision/p1-wrapped-secret",
            };
          } else if (input.physicalPage === 3) {
            yield {
              text: "【原图忠实转写，尚需核对】\nChapter 1: Mechanics\nExercise 1.\nFigure 1 caption.\nAnswer: x = 1.",
              imageObjectKey: "vision/p3-mixed-inline",
            };
          } else if (input.physicalPage === 4) {
            yield {
              text: "【原图忠实转写，尚需核对】\nTriangle ABC.\n\n【图表观察描述，非原文或解答】\nRight angle at C.",
              imageObjectKey: "vision/clean-diagram",
            };
          } else if (input.physicalPage === 5) {
            yield {
              text: "【原图忠实转写，尚需核对】\nPublic stem.\n\nAnswer Key\n1. x = 2\n\n【图表观察描述，非原文或解答】\nAnswer table sketch.",
              imageObjectKey: "vision/p5-partial-secret",
            };
          }
        }
      },
    });
    expect(liveWrapped.outcome).toEqual({ pages: 6 });
    expect(liveWrapped.pdfWarning).toBeUndefined();
    expect(liveWrapped.publishedChunks.map(c => c.page)).toEqual([3, 4, 5]);
    expect(liveWrapped.publishedChunks[0]?.text).toContain("Exercise 1.");
    expect(liveWrapped.publishedChunks[0]?.text).toContain("Figure 1 caption.");
    expect(liveWrapped.publishedChunks[0]?.text).not.toContain("Answer: x = 1.");
    expect(liveWrapped.publishedChunks[0]?.imageObjectKey).toBeNull();
    expect(liveWrapped.publishedChunks[1]?.text).toContain("Triangle ABC.");
    expect(liveWrapped.publishedChunks[1]?.text).toContain("Right angle at C.");
    expect(liveWrapped.publishedChunks[1]?.imageObjectKey).toBe("vision/clean-diagram");
    expect(liveWrapped.publishedChunks[2]?.text).toBe("[视觉转写与描述]\n【原图忠实转写，尚需核对】\nPublic stem.");
    expect(liveWrapped.publishedChunks[2]?.text).not.toContain("Answer table sketch.");
    expect(liveWrapped.publishedChunks[2]?.imageObjectKey).toBeNull();

    const degradedSavedWrapped = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "Chapter 2: Public\nIntro.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nAnswer Key\n1. x = 9\n\n【图表观察描述，非原文或解答】\nAnswer layout note.",
          imageObjectKey: "vision/stale-wrapped",
        },
      ],
      recognizePages: async function* () {
        yield null;
      },
    });
    expect(degradedSavedWrapped.publishedChunks.map(c => c.page)).toEqual([2]);
    expect(degradedSavedWrapped.publishedChunks[0]?.text).toBe("Chapter 2: Public\nIntro.");
  });

  it("Round-6 [P2]: exits section_sealed on 第 3 讲 and stays sealed on Section 1.2: Exercises", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        { page: 1, text: "Answer Key\n1. x = 1", visualKinds: [] },
        { page: 2, text: "第 3 讲 特征值\n定义：Ax = λx。", visualKinds: [] },
        { page: 3, text: "**Solutions to Selected Exercises**\n1. x = 2", visualKinds: [] },
        { page: 4, text: "Section 1.2: Exercises\n1. Solve y' = y.", visualKinds: [] },
      ],
    });
    expect(publishedChunks.map(c => c.page)).toEqual([2]);
    expect(publishedChunks[0]?.text).toBe("第 3 讲 特征值\n定义：Ax = λx。");
  });

  it("Round-7 [P1-3, P1-4]: redacts hadSealedContent images, suppresses descriptions on self-closed Vision seals, and guards 第 3 讲 参考答案", async () => {
    const decoded = decodeParserOutput(JSON.stringify({
      pages: [
        { page: 1, text: "Find x.", imagePath: null, visualKinds: ["picture"], hadSealedContent: true },
        { page: 2, text: "Public.", imagePath: null, visualKinds: [] },
      ],
    }));
    expect(decoded[0]).toEqual({ page: 1, text: "Find x.", imagePath: null, visualKinds: ["picture"], hadSealedContent: true });
    expect("hadSealedContent" in decoded[1]!).toBe(false);
    expect(() => decodeParserOutput(JSON.stringify({
      pages: [{ page: 1, text: "x", imagePath: null, hadSealedContent: "yes" }],
    }))).toThrow("invalid hadSealedContent metadata");

    const live = await runPdfScenario({
      pages: [
        { page: 1, text: "Find x.", visualKinds: ["picture"], hadSealedContent: true },
        { page: 2, text: "", visualKinds: ["scan"] },
        { page: 3, text: "Chapter 2: Public\nTheorem 1.", visualKinds: ["picture"] },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          if (input.physicalPage === 1) {
            yield {
              text: "【原图忠实转写，尚需核对】\nFigure 1.\n\nAnswer: x = 2.\n\n【图表观察描述，非原文或解答】\nShows x = 2.\n\n【识别不确定，不能据此判定正确】\nUnclear digit.",
              imageObjectKey: "vision/p1-inline-native-seal",
            };
          } else if (input.physicalPage === 2) {
            yield {
              text: "【原图忠实转写，尚需核对】\nPublic stem.\nAnswer Key\n1. x = 2\nEnd of Answers.\n\n【图表观察描述，非原文或解答】\nFull page shows x = 2.\n\n【识别不确定，不能据此判定正确】\nUncertain 2.",
              imageObjectKey: "vision/p2-self-closed-seal",
            };
          } else if (input.physicalPage === 3) {
            yield {
              text: "【原图忠实转写，尚需核对】\nFigure 3.\n\n【图表观察描述，非原文或解答】\nClean diagram.",
              imageObjectKey: "vision/p3-clean",
            };
          }
        }
      },
    });
    expect(live.pdfWarning).toBeUndefined();
    expect(live.publishedChunks.map(c => c.page)).toEqual([1, 2, 3]);
    expect(live.publishedChunks[0]?.text).toBe("Find x.");
    expect(live.publishedChunks[0]?.imageObjectKey).toBeNull();
    expect(live.publishedChunks[1]?.text).toBe("[视觉转写与描述]\n【原图忠实转写，尚需核对】\nPublic stem.");
    expect(live.publishedChunks[1]?.text).not.toContain("Shows x = 2.");
    expect(live.publishedChunks[1]?.text).not.toContain("Full page shows x = 2.");
    expect(live.publishedChunks[1]?.text).not.toContain("Uncertain 2.");
    expect(live.publishedChunks[1]?.imageObjectKey).toBeNull();
    expect(live.publishedChunks[2]?.text).toContain("Clean diagram.");
    expect(live.publishedChunks[2]?.imageObjectKey).toBe("vision/p3-clean");

    const lectureAnswerAndSavedSelfClosed = await runPdfScenario({
      pages: [
        { page: 1, text: "第 3 讲 参考答案\n1. x = 1", visualKinds: [] },
        { page: 2, text: "2. y = 2", visualKinds: [] },
        { page: 3, text: "第 3 讲 特征值\n定义：Ax = λx。", visualKinds: [] },
        { page: 4, text: "Lecture 4: Answer Key\n1. a = 3", visualKinds: [] },
        { page: 5, text: "2. b = 4", visualKinds: [] },
        { page: 6, text: "Lecture 5: Singular Values", visualKinds: [] },
        { page: 7, text: "Public problem.", visualKinds: ["scan"] },
      ],
      savedChunks: [
        {
          page: 7,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nPublic problem.\nAnswer Key\n1. x = 9\nEnd of Answers.\n\n【图表观察描述，非原文或解答】\nAnswer plot.",
          imageObjectKey: "vision/p7-stale",
        },
      ],
    });
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks.map(c => c.page)).toEqual([3, 6, 7]);
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks[0]?.text).toBe("第 3 讲 特征值\n定义：Ax = λx。");
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks[2]?.text).toBe("[视觉转写与描述]\n【原图忠实转写，尚需核对】\nPublic problem.");
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks[2]?.imageObjectKey).toBeNull();
  });

  it("Round-7 [P1-5]: preserves same-page Vision on sectionSealedAtEnd, keeps seal across resume/fallback, and replays scanned raw Vision", async () => {
    const liveSamePageVision = await runPdfScenario({
      pages: [
        { page: 1, text: "Theorem 1: Norm equivalence.", visualKinds: ["picture"], sectionSealedAtEnd: true, hadSealedContent: true },
        { page: 2, text: "2. y = 4", visualKinds: [] },
        { page: 3, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      recognizePages: async function* () {
        yield {
          text: "【原图忠实转写，尚需核对】\n## Norm Equivalence\nUnit ball diagram.\nAnswer Key\n1. x = 2\n\n【图表观察描述，非原文或解答】\nShows answer plot.",
          imageObjectKey: "vision/p1-theorem",
        };
      },
    });
    expect(liveSamePageVision.pdfWarning).toBeUndefined();
    expect(liveSamePageVision.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(liveSamePageVision.publishedChunks[0]?.text).toBe("[原生提取]\nTheorem 1: Norm equivalence.\n\n[视觉转写与描述]\n【原图忠实转写，尚需核对】\n## Norm Equivalence\nUnit ball diagram.");
    expect(liveSamePageVision.publishedChunks[0]?.imageObjectKey).toBeNull();

    const resumeReusable = await runPdfScenario({
      pages: [
        { page: 1, text: "Theorem 1.", visualKinds: ["picture"], sectionSealedAtEnd: true, hadSealedContent: true },
        { page: 2, text: "2. y = 4", visualKinds: [] },
        { page: 3, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[原生提取]\nTheorem 1.\n\n[视觉转写与描述]\n## Norm Equivalence\nDiagram caption.\nAnswer Key\n1. x = 2",
          imageObjectKey: "vision/old-p1",
        },
      ],
    });
    expect(resumeReusable.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(resumeReusable.publishedChunks[0]?.text).toContain("Diagram caption.");
    expect(resumeReusable.publishedChunks[0]?.imageObjectKey).toBeNull();

    const resumeDegradedFallback = await runPdfScenario({
      pages: [
        { page: 1, text: "Theorem 1.", visualKinds: ["picture"], sectionSealedAtEnd: true, hadSealedContent: true },
        { page: 2, text: "2. y = 4", visualKinds: [] },
        { page: 3, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[原生提取]\nTheorem 1.\n\n[视觉转写与描述]\n## Norm Equivalence\nDiagram caption.\nAnswer Key\n1. x = 2",
          imageObjectKey: "vision/old-p1",
        },
      ],
      recognizePages: async function* () {
        yield null;
      },
    });
    expect(resumeDegradedFallback.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(resumeDegradedFallback.publishedChunks[0]?.imageObjectKey).toBeNull();

    const replayedPages: number[] = [];
    const scannedResumeWithNullKey = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "2. y = 4", visualKinds: [] },
        { page: 3, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\nPublic stem.",
          imageObjectKey: null,
        },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          replayedPages.push(input.physicalPage);
          if (input.physicalPage === 1) {
            yield { text: "Public stem.\n\nAnswer Key\n1. x = 2", imageObjectKey: "vision/p1-cached" };
          }
        }
      },
    });
    expect(replayedPages).toEqual([1]);
    expect(scannedResumeWithNullKey.pdfWarning).toBeUndefined();
    expect(scannedResumeWithNullKey.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(scannedResumeWithNullKey.publishedChunks[0]?.text).toBe("[视觉转写与描述]\nPublic stem.");
    expect(scannedResumeWithNullKey.publishedChunks[0]?.imageObjectKey).toBeNull();
  });

  it("keeps Markdown review and untitled lecture headings sealed until a new topic", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        { page: 1, text: "Lecture 4: Solutions\n1. x = 5", visualKinds: [] },
        { page: 2, text: "## Lecture 1\n## Review", visualKinds: [] },
        { page: 3, text: "## 第 1 讲：\n## Exercises", visualKinds: [] },
        { page: 4, text: "## Lecture 4: Review\n2. y = 6\n## 2.1 x = 3", visualKinds: [] },
        { page: 5, text: "## 第 3 讲 思考题\n3. z = 7", visualKinds: [] },
        { page: 6, text: "Lecture 5: Singular Values\nTheorem 5.1: SVD exists.", visualKinds: [] },
        { page: 7, text: "Chapter 4: Solutions\n3. z = 7", visualKinds: [] },
        { page: 8, text: "第 4 讲 习题答案\n4. w = 8", visualKinds: [] },
        { page: 9, text: "Chapter 6: Projections\nDef. 6.1.", visualKinds: [] },
      ],
    });
    expect(publishedChunks.map(c => c.page)).toEqual([6, 9]);
    expect(publishedChunks[0]?.text).toBe("Lecture 5: Singular Values\nTheorem 5.1: SVD exists.");
  });

  it("drops an unheaded Vision answer even when a later line has an inline answer marker", async () => {
    const { outcome, pdfWarning, publishedChunks } = await runPdfScenario({
      pages: [
        { page: 1, text: "Find x.", visualKinds: ["picture"], hadSealedContent: true },
      ],
      recognizePages: async function* () {
        yield { text: "【原图忠实转写，尚需核对】\n1. x = 5\nAnswer: y = 6", imageObjectKey: "vision/p1-missed-heading" };
      },
    });
    expect(outcome).toEqual({ pages: 1 });
    expect(pdfWarning).toBeUndefined();
    expect(publishedChunks).toHaveLength(1);
    expect(publishedChunks[0]?.text).toBe("Find x.");
    expect(publishedChunks[0]?.imageObjectKey).toBeNull();
  });

  it.each(["1. y = 9", "1. y = 9\nAnswer: z = 10"])("drops unheaded saved Vision-only text on a contaminated page (%s)", async (visionText) => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        { page: 1, text: "Find y.", visualKinds: ["picture"], hadSealedContent: true },
      ],
      savedChunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: `[视觉转写与描述]\n${visionText}`,
          imageObjectKey: "vision/p1-stale-leaked",
        },
      ],
    });
    expect(publishedChunks).toHaveLength(1);
    expect(publishedChunks[0]?.text).toBe("Find y.");
    expect(publishedChunks[0]?.imageObjectKey).toBeNull();
  });

  it("opens contaminated Vision only at an explicit public heading and closes at the next answer marker", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [{ page: 1, text: "Find x.", visualKinds: ["picture"], hadSealedContent: true }],
      recognizePages: async function* () {
        yield {
          text: "1. x = 5\nChapter 2: Rings\nPublic diagram caption.\nAnswer: y = 6\n\n2. z = 7",
          imageObjectKey: "vision/p1-contaminated",
        };
      },
    });
    expect(publishedChunks[0]?.text).toBe("[原生提取]\nFind x.\n\n[视觉转写与描述]\nChapter 2: Rings\nPublic diagram caption.");
    expect(publishedChunks[0]?.imageObjectKey).toBeNull();
  });

  it("starts Vision from the incoming seal and consumes cached batch results on partial degradation", async () => {
    const mixedExitFromIncomingSeal = await runPdfScenario({
      pages: [
        { page: 1, text: "Answer Key\n1. x = 1", visualKinds: [] },
        { page: 2, text: "2. y = 4\nChapter 2: Vector Spaces\nDef. 2.1", visualKinds: ["picture"], hadSealedContent: true },
        { page: 3, text: "Theorem 2.2: Public basis.", visualKinds: [] },
      ],
      recognizePages: async function* () {
        yield {
          text: "【原图忠实转写，尚需核对】\n2. y = 4\nFigure 2.1: Plot.\n\n【图表观察描述，非原文或解答】\nShows y = 4.",
          imageObjectKey: "vision/p2-missed-chapter",
        };
      },
    });
    expect(mixedExitFromIncomingSeal.pdfWarning).toBeUndefined();
    expect(mixedExitFromIncomingSeal.publishedChunks.map(c => c.page)).toEqual([2, 3]);
    expect(mixedExitFromIncomingSeal.publishedChunks[0]?.text).toBe("Chapter 2: Vector Spaces\nDef. 2.1");
    expect(mixedExitFromIncomingSeal.publishedChunks[0]?.text).not.toContain("2. y = 4");
    expect(mixedExitFromIncomingSeal.publishedChunks[0]?.imageObjectKey).toBeNull();
    expect(mixedExitFromIncomingSeal.publishedChunks[1]?.text).toBe("Theorem 2.2: Public basis.");

    const mixedExitReenteringNewSeal = await runPdfScenario({
      pages: [
        { page: 1, text: "Answer Key\n1. x = 1", visualKinds: [] },
        { page: 2, text: "2. y = 4\nChapter 2: Vector Spaces\nDef. 2.1", visualKinds: ["picture"] },
        { page: 3, text: "2. k = 9", visualKinds: [] },
        { page: 4, text: "Chapter 3: Orthogonal Sets", visualKinds: [] },
      ],
      recognizePages: async function* () {
        yield {
          text: "【原图忠实转写，尚需核对】\n2. y = 4\nChapter 2: Vector Spaces\nFigure 2.1: Plot.\n\nAnswer Key\n1. z = 9",
          imageObjectKey: "vision/p2-reenter",
        };
      },
    });
    expect(mixedExitReenteringNewSeal.publishedChunks.map(c => c.page)).toEqual([2, 4]);
    expect(mixedExitReenteringNewSeal.publishedChunks[0]?.text).toContain("Figure 2.1: Plot.");
    expect(mixedExitReenteringNewSeal.publishedChunks[0]?.text).not.toContain("2. y = 4");
    expect(mixedExitReenteringNewSeal.publishedChunks[0]?.text).not.toContain("1. z = 9");
    expect(mixedExitReenteringNewSeal.publishedChunks[0]?.imageObjectKey).toBeNull();

    const workerStrippedInlineVisionDesc = await runPdfScenario({
      pages: [
        { page: 1, text: "Problem 1.\nAnswer: x = 2.", visualKinds: ["picture"] },
      ],
      recognizePages: async function* () {
        yield {
          text: "【原图忠实转写，尚需核对】\nChapter 2: Vector Spaces\nFigure 1.\nAnswer: x = 2.\n\n【图表观察描述，非原文或解答】\nShows x = 2.",
          imageObjectKey: "vision/inline-worker-strip",
        };
      },
    });
    expect(workerStrippedInlineVisionDesc.publishedChunks[0]?.text).toBe("[原生提取]\nProblem 1.\n\n[视觉转写与描述]\n【原图忠实转写，尚需核对】\nChapter 2: Vector Spaces\nFigure 1.");
    expect(workerStrippedInlineVisionDesc.publishedChunks[0]?.imageObjectKey).toBeNull();

    const partialDegradationBatch = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "", visualKinds: ["scan"] },
        { page: 3, text: "2. y = 4", visualKinds: [] },
        { page: 4, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      savedChunks: [
        {
          page: 2,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\nPublic stem.",
          imageObjectKey: null,
        },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          if (input.physicalPage === 1) yield null;
          else if (input.physicalPage === 2) yield { text: "Public stem.\nAnswer Key\n1. x = 2", imageObjectKey: "vision/p2-cached" };
        }
      },
    });
    expect(partialDegradationBatch.publishedChunks.map(c => c.page)).toEqual([2, 4]);
    expect(partialDegradationBatch.publishedChunks[0]?.text).toBe("[视觉转写与描述]\nPublic stem.");
    expect(partialDegradationBatch.publishedChunks[0]?.imageObjectKey).toBeNull();
  });
});
