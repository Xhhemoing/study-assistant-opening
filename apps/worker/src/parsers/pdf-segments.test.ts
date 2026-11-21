import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { NewSourceChunk, OpeningJobRecord, OpeningPdfSegmentsRepository, PdfSegment, PdfSegmentIdentity, PdfSegmentPage } from "@aistudy/database";
import { createParseSourceHandler } from "../jobs/parse-source";
import { BoundsExceededError } from "./docling-process";
import { MAX_PDF_BOOK_PAGES, parsePdfSegments, watchPdfExecution, type PdfSegmentBatch } from "./pdf-segments";
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
        if (physicalPage === 2) return { text: "Answers to Selected Exercises\n1.1 x = 3\n1.2 y = 4", imageObjectKey: "vision/p2-secret" };
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
});
