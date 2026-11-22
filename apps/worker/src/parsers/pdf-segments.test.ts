import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OpeningModelRoutingError } from "@aistudy/ai";
import type { SourceRecord } from "@aistudy/contracts";
import type { NewSourceChunk, OpeningJobRecord, OpeningPdfSegmentsRepository, PdfSegment, PdfSegmentIdentity, PdfSegmentPage } from "@aistudy/database";
import { createParseSourceHandler, sealTextWithState, type ParseSourceVisualPageInput, type ParseSourceVisualPageResult } from "../jobs/parse-source";
import { BoundsExceededError, decodeParserOutput } from "./docling-process";
import { MAX_PDF_BOOK_PAGES, parsePdfSegments, watchPdfExecution, type PdfSegmentBatch } from "./pdf-segments";
import { pdfParserProfile } from "./ocr-health";
import { loadParserConfig } from "./parser-config";
import { createParserSubprocessEnv } from "./subprocess-env";
import type { ParserRunner, VisualPageKind } from "./types";

const scope = { workspaceId: "w", ownerUserId: "u", jobExecution: { id: "job", token: "claim", privacyEpoch: 0 } };
function setup(total = 23) {
  const data = new Map<string, PdfSegment>();
  const key = (i: PdfSegmentIdentity) => `${i.sourceId}/${i.sourceVersion}/${i.parserProfile}/${i.pageStart}-${i.pageEnd}`;
  const segments: OpeningPdfSegmentsRepository = {
    assertCurrent: vi.fn(async () => {}),
    read: vi.fn(async (_scope, i) => data.get(key(i)) ?? null),
    readPageSeals: vi.fn(async () => []),
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
      { state: "ready", pages: [...first] }, d.input.signal, [], false);
    d.ranges.length = 0;
    expect(await collectPdfSegments(d.input)).toEqual(first);
    expect(d.ranges).toEqual([]);
  });

  it.each([
    "docling-2.126.0/pdf-segments-v3-visual/text",
    "docling-2.126.0/pdf-segments-v11-discourse/text",
    "docling-2.126.0/pdf-segments-v12-discourse/text",
    "docling-2.126.0/pdf-segments-v13-discourse/text",
    "docling-2.126.0/pdf-segments-v17-discourse/text",
    "docling-2.126.0/pdf-segments-v18-discourse/text",
    "docling-2.126.0/pdf-segments-v19-discourse/text",
    "docling-2.126.0/pdf-segments-v20-discourse/text",
  ])("does not reuse segments cached with the older profile %s", async legacyProfile => {
    const d = setup(2);
    await collectPdfSegments({ ...d.input, parserProfile: legacyProfile });
    const profile = pdfParserProfile({});
    expect(profile).toBe("docling-2.126.0/pdf-segments-v21-discourse/text");
    expect(profile).not.toBe(legacyProfile);
    d.ranges.length = 0;
    await collectPdfSegments({ ...d.input, parserProfile: profile });
    expect(d.ranges).toEqual([[1, 2]]);
    d.ranges.length = 0;
    await collectPdfSegments({ ...d.input, parserProfile: profile });
    expect(d.ranges).toEqual([]);
  });

  it("re-extracts a ready segment carrying its own pending failed boundary", async () => {
    const d = setup(2);
    const pages = await collectPdfSegments(d.input);
    const key = [...d.data.keys()][0]!;
    d.data.set(key, { state: "ready", pages: [...pages], requiresRevalidation: true });
    d.ranges.length = 0;
    expect(await collectPdfSegments(d.input)).toEqual(pages);
    expect(d.ranges).toEqual([[1, 2]]);
    expect(d.segments.save).toHaveBeenLastCalledWith(scope, expect.objectContaining({ pageStart: 1, pageEnd: 2 }),
      { state: "ready", pages: [...pages] }, d.input.signal, [], true);
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

  it("leaves the failure cache untouched if archived coverage inspection is interrupted", async () => {
    const d = setup(2);
    d.failures.add(2);
    await expect(parsePdfSegments({ ...d.input, segmentPages: 1, onPages: () => {},
      onFailedSegment: ({ pageStart }) => {
        expect(pageStart).toBe(2);
        expect(d.data.has("source/0/text-v1/2-2")).toBe(false);
        throw new Error("interrupted before archive inspection finished");
      },
    })).rejects.toThrow("interrupted before archive inspection finished");
    expect(d.segments.save).toHaveBeenCalledOnce();
  });

  it("rejects a mandatory over-quota page before saving or consuming its window", async () => {
    const d = setup(2);
    d.input.runner = async argv => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":2}' };
      const page = Number(argv[argv.indexOf("--page-start") + 1]);
      return { exitCode: 0, stdout: JSON.stringify({ pages: [{ page, text: "x".repeat(600), imagePath: null }] }) };
    };
    const onPages = vi.fn();
    await expect(parsePdfSegments({ ...d.input, segmentPages: 1, maxBookBytes: 1024, onPages })).rejects.toBeInstanceOf(BoundsExceededError);
    expect(onPages).toHaveBeenCalledOnce();
    expect(d.segments.save).toHaveBeenCalledOnce();
  });

  it("charges a speculative window's consumed prefix to the book quota on live and cached reads", async () => {
    const d = setup(4);
    d.input.runner = async argv => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":4}' };
      const start = Number(argv[argv.indexOf("--page-start") + 1]);
      const end = Number(argv[argv.indexOf("--page-end") + 1]);
      d.ranges.push([start, end]);
      return { exitCode: 0, stdout: JSON.stringify({
        pages: Array.from({ length: end - start + 1 }, (_, i) => ({
          page: start + i, text: "x".repeat(start + i < 4 ? 300 : argv.includes("section_sealed") ? 0 : 220), imagePath: null,
        })),
      }) };
    };
    const parse = () => parsePdfSegments({ ...d.input, maxBookBytes: 1024,
      onPages: pages => { if (pages[0]?.page === 1) return { resumeFromPage: 4, nextSealMode: "section_sealed" }; },
    });
    await expect(parse()).resolves.toEqual({ pageCount: 4, failedRanges: [] });
    expect(d.ranges).toEqual([[1, 4], [4, 4]]);
    d.ranges.length = 0;
    await expect(parse()).resolves.toEqual({ pageCount: 4, failedRanges: [] });
    expect(d.ranges).toEqual([]);
  });

  it.each(["inline_sealed", "section_sealed"])("passes cached page 10's %s state to page 11 and separates differently seeded cache entries", async mode => {
    const d = setup(11);
    const runner = d.input.runner;
    const seedKey = mode === "inline_sealed" ? "inlineSealedAtEnd" : "sectionSealedAtEnd";
    d.data.set("source/0/text-v1/1-10", {
      state: "ready",
      pages: Array.from({ length: 10 }, (_, index) => ({
        page: index + 1, text: "Public", imagePath: null,
        ...(index === 9 ? { [seedKey]: true, hadSealedContent: true } : {}),
      })),
    });
    // A previous attempt could parse the tail after an unavailable first range.
    d.data.set("source/0/text-v1/11-11", {
      state: "ready", pages: [{ page: 11, text: "5 units.", imagePath: null }],
    });
    const seeds: string[] = [];
    d.input.runner = async (argv, signal) => {
      if (argv.includes("--inspect-pdf")) return runner(argv, signal);
      const flagIndex = argv.indexOf("--initial-seal-mode");
      seeds.push(flagIndex === -1 ? "none" : argv[flagIndex + 1]!);
      return { exitCode: 0, stdout: JSON.stringify({
        pages: [{ page: 11, text: flagIndex === -1 ? "5 units." : "", imagePath: null, hadSealedContent: true }],
      }) };
    };
    expect((await collectPdfSegments(d.input)).at(-1)?.text).toBe("");
    expect(seeds).toEqual([mode]);
    expect((await collectPdfSegments(d.input)).at(-1)?.text).toBe("");
    expect(seeds).toEqual([mode]);
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
    // The consumer must be able to discard a speculative tail before the book quota is assessed.
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

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

  async function runPptxScenario(page: { text: string; hadSealedContent?: boolean }, previousChunks: NewSourceChunk[] = []) {
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

      const publishedChunks = [...previousChunks];
      const replaceChunks = vi.fn<Parameters<typeof createParseSourceHandler>[0]["chunks"]["replaceChunks"]>(
        async (_scope, publication) => {
          if (!publication.chunks.length && !publication.allowSealedEmpty) throw new Error("source has no readable text");
          publishedChunks.splice(0, publishedChunks.length, ...publication.chunks);
        },
      );
      const pptxHandler = createParseSourceHandler({
        sources: { get: async () => pptxSource, markParseState: async () => pptxSource },
        chunks: {
          replaceChunks,
          replacePdfChunks: async () => {},
          listChunksAtVersion: async () => [],
        },
        storage: {
          finalKey: () => "sources/test/0/original",
          presignGet: async () => `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${pdfBytes.toString("base64")}`,
        },
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ pages: [{ page: 1, imagePath: null, ...page }] }),
        }),
        tempDir,
      });

      await pptxHandler(jobRecord, { sourceId: pptxSource.id, sourceVersion: 0 });
      return { publishedChunks, replaceChunks };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  it("preserves astral math symbols while sealing PPTX answers", async () => {
    const { publishedChunks } = await runPptxScenario({
      text: "Exercise 1: Compute 𝑥 + 1.\nAnswer Key: 𝑥 = 2.\n\nTheorem 1: 𝑥 ∈ ℝ.",
    });
    expect(publishedChunks.map(chunk => chunk.text)).toEqual(["Exercise 1: Compute 𝑥 + 1.\nTheorem 1: 𝑥 ∈ ℝ."]);
  });

  it("withdraws stale chunks when every PPTX slide has been sealed", async () => {
    const { publishedChunks, replaceChunks } = await runPptxScenario({ text: "", hadSealedContent: true }, [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "1.1 x = 3", imageObjectKey: null },
    ]);
    expect(replaceChunks.mock.calls.map(([, input]) => input)).toMatchObject([{ chunks: [], allowSealedEmpty: true }]);
    expect(publishedChunks).toEqual([]);
  });

  it("rejects an unsealed blank PPTX", async () => {
    await expect(runPptxScenario({ text: "", hadSealedContent: false })).rejects.toThrow("source has no readable text");
  });

  async function runPdfScenario(options: {
    savedChunks?: NewSourceChunk[];
    failedStarts?: number[];
    beforePublish?: () => void;
    withoutSegments?: boolean;
    previousCappedPages?: number[];
    segmentPages?: number;
    segmentData?: Map<string, PdfSegment>;
    recognizePage?: (input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult | null>;
    recognizePages?: (
      inputs: readonly ParseSourceVisualPageInput[],
      cacheOnly?: boolean,
    ) => AsyncGenerator<ParseSourceVisualPageResult | null, void, void>;
  } & ({
    pages: Array<{
      page: number;
      text: string;
      visualKinds?: VisualPageKind[];
      discourseBlocks?: Array<Record<string, unknown>>;
      sectionSealedAtEnd?: boolean;
      inlineSealedAtEnd?: boolean;
      hadSealedContent?: boolean;
      inWorkedExampleAtEnd?: boolean;
    }>;
  } | {
    pageCount: number;
    extractRange: (start: number, end: number, seed?: string, workedExample?: boolean) => string;
  })) {
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
        ...(options.previousCappedPages ? { pdfTextCap: options.previousCappedPages } : {}),
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
        claimToken: options.withoutSegments ? null : "claim-r3",
        privacyEpoch: 0,
      } as OpeningJobRecord;

      const publishedChunks: NewSourceChunk[] = [];
      let preservePages: number[] = [];
      let pdfWarning: unknown = undefined;
      let allowSealedEmpty: boolean | undefined;
      const requests: Array<{ start: number; seed?: string; workedExample?: true }> = [];
      const segmentReads: PdfSegmentIdentity[] = [];
      const savedMap = new Map((options.savedChunks ?? []).map(chunk => [chunk.page, chunk]));
      const segmentData = options.segmentData ?? new Map<string, PdfSegment>();
      const cacheKey = (identity: PdfSegmentIdentity) => `${identity.parserProfile}/${identity.pageStart}-${identity.pageEnd}`;
      const failureBoundary = /\/publication-failure-(pending|settled)-(\d+)(?=\/\d+-\d+$)/u;
      const storedKey = (identity: PdfSegmentIdentity) => {
        const key = cacheKey(identity);
        return [...segmentData.keys()].find(stored => stored.replace(failureBoundary, "") === key) ?? key;
      };
      const segments: Pick<OpeningPdfSegmentsRepository, "read" | "readPageSeals" | "save"> = {
        read: async (_scope, identity) => {
          segmentReads.push(identity);
          return segmentData.get(storedKey(identity)) ?? null;
        },
        readPageSeals: async (_scope, identity) => {
          const markers = new Map<number, PdfSegmentPage>();
          for (const key of segmentData.keys()) {
            const page = Number(failureBoundary.exec(key)?.[2]);
            if (page >= identity.pageStart && page <= identity.pageEnd) {
              markers.set(page, { page, text: "", imagePath: null, publicationSealUnknown: true, failedRangeBoundary: true });
            }
          }
          for (let page = identity.pageStart; page <= identity.pageEnd; page++) {
            const value = segmentData.get(cacheKey({ ...identity, pageStart: page, pageEnd: page }));
            const marker = value?.state === "ready" ? value.pages[0] : undefined;
            if (marker) markers.set(page, marker);
          }
          return [...markers.values()];
        },
        save: async (_scope, identity, value, _signal, blockingSeals = []) => {
          const key = storedKey(identity);
          if (!blockingSeals.length) {
            segmentData.set(key, value);
            return;
          }
          const existing = failureBoundary.exec(key);
          const boundary = Math.min(existing?.[1] === "pending" ? Number(existing[2]) : Infinity,
            ...blockingSeals.map(marker => marker.page));
          segmentData.delete(key);
          segmentData.set(cacheKey({ ...identity, parserProfile: identity.parserProfile + "/publication-failure-pending-" + boundary }), value);
        },
      };

      const handler = createParseSourceHandler({
        sources: { get: async () => pdfSource, markParseState: async () => pdfSource },
        chunks: {
          replaceChunks: async () => {},
          replacePdfChunks: async (_scope, publication) => {
            for await (const chunk of publication.chunks) publishedChunks.push(chunk);
            preservePages = publication.preservePages;
            pdfWarning = publication.warning;
            allowSealedEmpty = publication.allowSealedEmpty;
            options.beforePublish?.();
            const cleared = new Set<number>();
            for (const marker of publication.publicationSeals ?? []) {
              const key = `pdf-publication-page-seal-v1/${marker.page}-${marker.page}`;
              if (marker.hadSealedContent || marker.sectionSealedAtEnd || marker.inlineSealedAtEnd || marker.publicationSealUnknown) {
                segmentData.set(key, { state: "ready", pages: [{ ...marker, publicationSealCommitted: true }] });
              } else {
                segmentData.delete(key);
                cleared.add(marker.page);
              }
            }
            for (const [key, value] of [...segmentData]) {
              const match = failureBoundary.exec(key);
              if (!match) continue;
              const next = cleared.has(Number(match[2])) ? key.replace(failureBoundary, "")
                : key.replace("/publication-failure-pending-", "/publication-failure-settled-");
              if (next !== key) {
                segmentData.delete(key);
                segmentData.set(next, value);
              }
            }
          },
          listChunksAtVersion: async (_scope, _sourceId, _sourceVersion, pageNumbers) =>
            pageNumbers.flatMap(page => {
              const saved = savedMap.get(page);
              return saved ? [{ ...saved, sourceId: pdfSource.id, sourceVersion: 0, workspaceId: pdfSource.workspaceId, id: `chunk-${page}`, createdAt: new Date().toISOString() }] : [];
            }),
        },
        ...(options.withoutSegments ? {} : { segments }),
        segmentPages: options.segmentPages,
        storage: {
          finalKey: () => "sources/test/0/original",
          presignGet: async () => `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
        },
        runner: async argv => {
          if (argv.includes("--inspect-pdf")) {
            return { exitCode: 0, stdout: JSON.stringify({ pageCount: "pages" in options ? options.pages.length : options.pageCount }) };
          }
          const start = Number(argv[argv.indexOf("--page-start") + 1]);
          const end = Number(argv[argv.indexOf("--page-end") + 1]);
          const seedIndex = argv.indexOf("--initial-seal-mode");
          const seed = seedIndex === -1 ? undefined : argv[seedIndex + 1];
          const workedExample = argv.includes("--initial-in-worked-example");
          requests.push({ start, ...(seed ? { seed } : {}), ...(workedExample ? { workedExample: true } : {}) });
          if (options.failedStarts?.includes(start)) return { exitCode: 4, stdout: "" };
          if ("extractRange" in options) return { exitCode: 0, stdout: options.extractRange(start, end, seed, workedExample) };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              pages: options.pages
                .filter(p => p.page >= start && p.page <= end)
                .map(p => ({ ...p, imagePath: null, visualKinds: p.visualKinds ?? [] })),
            }),
          };
        },
        ...(options.recognizePage ? { recognizePage: options.recognizePage } : {}),
        ...(options.recognizePages ? { recognizePages: options.recognizePages } : {}),
        assertCurrent: async () => {},
        tempDir,
      });

      const outcome = await handler(jobRecord, { sourceId: pdfSource.id, sourceVersion: 0 });
      return { outcome, publishedChunks, preservePages, pdfWarning, allowSealedEmpty, requests, segmentReads };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const python = loadParserConfig();
  describe.skipIf(!process.env.PARSER_PYTHON && !existsSync(python.pythonExecutable))("Python CLI to PDF worker", () => {
    let fixtures: Record<string, { pageCount: number; ranges: Record<string, { pages: PdfSegmentPage[] }> }>;

    beforeAll(() => {
      fixtures = JSON.parse(execFileSync(python.pythonExecutable, ["-B", "tests/test_physical_pages_docling.py", "--worker-fixtures"], {
        cwd: python.cwd, windowsHide: true, encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...createParserSubprocessEnv("python"), PYTHONPATH: python.cwd },
      }));
    }, 50_000);

    function runCliScenario(name: string, options: Omit<Parameters<typeof runPdfScenario>[0], "pages"> = {}) {
      const fixture = fixtures[name]!;
      return runPdfScenario({ ...options, pageCount: fixture.pageCount, extractRange(start, end, seed, workedExample) {
        const key = `${start}-${end}/${seed ?? ""}${workedExample ? "/we" : ""}`;
        expect(fixture.ranges[key], `${name}: ${key}`).toBeDefined();
        return JSON.stringify(fixture.ranges[key]);
      } });
    }

    it("re-extracts the rest of a seeded window after its first scan reopens the section", async () => {
      const result = await runCliScenario("previous_answer_key", {
        recognizePage: async () => ({ text: "Chapter 2: Vectors", imageObjectKey: "vision/chapter" }),
      });
      expect(result.outcome).toEqual({ pages: 23 });
      expect(result.requests).toEqual([{ start: 1 }, { start: 11, seed: "section_sealed" }, { start: 12 }, { start: 21 }]);
      expect(result.publishedChunks.slice(9, 11).map(({ page, text }) => [page, text])).toEqual([
        [11, "[视觉转写与描述]\nChapter 2: Vectors"], [12, "Public continuation."],
      ]);
    });

    it.each([1, 2, 3])("replays a newly sealed tail with %i-page windows to recover the Docling section exit", async segmentPages => {
      const result = await runCliScenario("vision_section_exit", {
        segmentPages, recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "vision/key" }),
      });
      expect(result.outcome).toEqual({ pages: 3 });
      expect(result.requests).toContainEqual({ start: 2, seed: "section_sealed" });
      expect(result.publishedChunks.map(({ page }) => page)).toEqual([2, 3]);
      expect(result.publishedChunks[0]?.text).toContain("Vector Spaces");
      expect(result.publishedChunks[0]?.text).not.toContain("5 units.");
    });

    it("revalidates sealed ranges and replays mixed-page Vision without publishing its continuation", async () => {
      const segmentData = new Map<string, PdfSegment>();
      const visionCalls: Array<[number, boolean | undefined]> = [];
      let retry = false;
      async function* recognizePages(inputs: readonly ParseSourceVisualPageInput[], cacheOnly?: boolean) {
        for (const { physicalPage, nativeText, visualKinds } of inputs) {
          visionCalls.push([physicalPage, cacheOnly]);
          if (physicalPage === 1) yield retry ? null : { text: "Answer: x = 3.", imageObjectKey: "vision/lead" };
          else if (physicalPage === 13) yield { text: "Chapter 2: Vectors", imageObjectKey: "vision/chapter" };
          else {
            expect({ physicalPage, nativeText, visualKinds }).toEqual({ physicalPage: 14, nativeText: "1. Find x.", visualKinds: ["picture"] });
            yield { text: "1. Find x.\nAnswer: x =", imageObjectKey: "vision/exercise" };
          }
        }
      }
      const first = await runCliScenario("same_segment_answer_key", { segmentData, recognizePages });
      expect(first.outcome).toEqual({ pages: 23 });
      expect(first.requests).toEqual([{ start: 1 }, { start: 11 }, { start: 14 }, { start: 15, seed: "inline_sealed" }, { start: 21 }]);
      expect(first.publishedChunks.filter(chunk => chunk.page >= 12 && chunk.page <= 15)).toMatchObject([
        { page: 13, text: "[视觉转写与描述]\nChapter 2: Vectors", imageObjectKey: null },
        { page: 14, text: "[原生提取]\n1. Find x.\n\n[视觉转写与描述]\n1. Find x.", imageObjectKey: null },
      ]);
      expect(visionCalls).toEqual([[1, false], [13, false], [14, false]]);

      retry = true;
      visionCalls.length = 0;
      const cached = await runCliScenario("same_segment_answer_key", { segmentData, recognizePages, savedChunks: first.publishedChunks });
      expect(cached.requests).toEqual([{ start: 1 }, { start: 11 }, { start: 14 }, { start: 15, seed: "inline_sealed" }]);
      expect(cached.segmentReads.filter(({ parserProfile }) => !parserProfile.startsWith("pdf-publication-")).map(({ pageStart, pageEnd }) => [pageStart, pageEnd])).toEqual([[1, 10], [11, 20], [14, 20], [15, 20], [21, 23]]);
      expect(visionCalls).toEqual([[1, false], [13, true], [14, true]]);
      expect(cached.publishedChunks.filter(chunk => chunk.page >= 12 && chunk.page <= 15))
        .toEqual(first.publishedChunks.filter(chunk => chunk.page >= 12 && chunk.page <= 15));
    });

    it("keeps an exercise and its continuation public after an all-inline-answer page", async () => {
      const result = await runCliScenario("completed_inline");
      expect(result.publishedChunks.slice(-2).map(({ page, text }) => [page, text])).toEqual([
        [11, "2. Calculate y."], [12, "Use the diagram for this exercise."],
      ]);
    });

    it("withdraws a previously public continuation after a newly confirmed seal and two conversion failures", async () => {
      const segmentData = new Map<string, PdfSegment>();
      const first = await runCliScenario("failed_sealed_retry", { segmentData,
        recognizePage: async () => ({ text: "Chapter 1: Geometry", imageObjectKey: "vision/chapter" }),
      });
      expect(first.publishedChunks.at(-1)).toMatchObject({ page: 11, text: "5 units." });
      const retry = await runCliScenario("failed_sealed_retry", {
        segmentData, savedChunks: first.publishedChunks.filter(chunk => chunk.page !== 10), failedStarts: [11],
        recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "vision/key" }),
      });
      expect(retry.requests).toEqual([{ start: 11, seed: "section_sealed" }, { start: 11, seed: "section_sealed" }]);
      expect(retry.preservePages).not.toContain(11);
      expect(retry.publishedChunks.some(chunk => chunk.page === 11)).toBe(false);
      expect(retry.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL", message: expect.stringContaining("第 11 页未能识别，可以重新解析") });
    });

    it("seals sentence-case answer labels in both native and Vision text", async () => {
      const result = await runCliScenario("sentence_case_answer", {
        recognizePage: async () => ({ text: "Chapter 2: Vectors\nCorrect answer： x = 3.", imageObjectKey: "vision/diagram" }),
      });
      expect(result.publishedChunks.map(chunk => chunk.text)).toEqual([
        "Exercise 1: Find x.", "[视觉转写与描述]\nChapter 2: Vectors",
      ]);
      expect(result.publishedChunks[1]?.imageObjectKey).toBeNull();
    });

    it("carries a native worked example through a segment boundary and its cached retry", async () => {
      const segmentData = new Map<string, PdfSegment>();
      const first = await runCliScenario("worked_example", { segmentData });
      expect(first.requests).toEqual([{ start: 1 }, { start: 11, workedExample: true }]);
      expect(first.publishedChunks.at(-2)?.text).toBe("Solution: Take the square root.");
      const retry = await runCliScenario("worked_example", { segmentData, savedChunks: first.publishedChunks });
      expect(retry.requests).toEqual([]);
      expect(retry.segmentReads.filter(({ parserProfile }) => !parserProfile.startsWith("pdf-publication-")).at(-1)?.parserProfile).toMatch(/\/we$/u);
      expect(retry.publishedChunks).toEqual(first.publishedChunks);
    });

    it("re-extracts a window tail when Vision identifies a worked example", async () => {
      const result = await runCliScenario("vision_worked_example", {
        recognizePage: async () => ({ text: "Worked Example 1: Find x.", imageObjectKey: "vision/example" }),
      });
      expect(result.requests).toEqual([{ start: 1 }, { start: 10, workedExample: true }]);
      expect(result.publishedChunks.at(-1)).toMatchObject({ page: 10, text: "Solution: Take the square root." });
    });
  });

  it("does not use an unsafe saved image on a sealed failed page as evidence that the next range is public", async () => {
    const result = await runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: ["scan"] },
        { page: 2, text: "5 units." },
        { page: 3, text: "6 units." },
        { page: 4, text: "Chapter 2: Vectors" },
      ],
      savedChunks: [{ page: 2, slideLabel: null, startMs: null, endMs: null, text: "5 units.", imageObjectKey: "old/page-2" }],
      segmentPages: 1,
      failedStarts: [2],
      recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "vision/key" }),
    });
    expect(result.requests).toEqual([{ start: 1 }, ...[2, 2, 3, 4].map(start => ({ start, seed: "section_sealed" }))]);
    expect(result.preservePages).toEqual([]);
    expect(result.publishedChunks.map(chunk => chunk.text)).toEqual(["Chapter 2: Vectors"]);
    expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
  });

  it.each([false, true])("preserves a clean native citation and publishes the next range after a failed retry (capped: %s)", async capped => {
    const text = capped ? "x".repeat(100_000) : "This first page is already readable and cited.";
    const result = await runPdfScenario({
      pages: [{ page: 1, text }, { page: 2, text: "Recovered second page" }],
      savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text, imageObjectKey: null }],
      segmentPages: 1,
      failedStarts: [1],
      ...(capped ? { previousCappedPages: [1] } : {}),
    });
    expect(result.preservePages).toEqual([1]);
    expect(result.publishedChunks).toMatchObject([{ page: 2, text: "Recovered second page" }]);
    expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
    if (capped) expect(result.pdfWarning).toMatchObject({ pdfTextCap: [1] });
  });

  it.each(["native", "Vision"])("remembers a %s seal when a retry changes the segment size", async origin => {
    const original = "Chapter 1: Geometry\nAnswer Key";
    const pages = [
      origin === "native" ? { page: 1, text: original } : { page: 1, text: "", visualKinds: ["scan" as const] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" },
    ];
    const segmentData = new Map<string, PdfSegment>();
    const first = await runPdfScenario({ pages, segmentData,
      recognizePage: async () => ({ text: original, imageObjectKey: "vision/key" }),
    });
    expect(first.publishedChunks[0]?.text).toContain("Chapter 1: Geometry");
    expect(first.publishedChunks.map(chunk => chunk.page)).toEqual([1, 3]);
    expect(segmentData.get(`pdf-publication-page-seal-v1/1-1`)).toMatchObject({
      state: "ready", pages: [{ page: 1, text: "", sectionSealedAtEnd: true, hadSealedContent: true }],
    });
    const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks, segmentPages: 1, failedStarts: [1] });
    expect(retry.preservePages).not.toContain(1);
    expect(retry.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
  });

  it.each(["Appendix A: Model Answer", "APPENDIX A: OFFICIAL SOLUTION", "Chapter 3: Reference Solution",
    "Section 1.2: Sample answer", "Lecture 4: Selected answers", "Part II: Correct Answer",
    "Unit 1: Odd-numbered solutions", "附录 A：Model answer", "第 3 章：Reference answer: x = 4."])(
    "treats %s as an answer section across pages", async title => {
      const result = await runPdfScenario({ segmentPages: 1, pages: [
        { page: 1, text: title + "\nx = 4." },
        { page: 2, text: "5 units." },
        { page: 3, text: "Chapter 5: Vectors" },
      ] });
      expect(result.requests[1]).toEqual({ start: 2, seed: "section_sealed" });
      expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
    },
  );

  it.each([{ kinds: [] as VisualPageKind[] }, { kinds: ["picture" as const] }])(
    "restores an archived Vision seal on native-cache replay and after changing the OCR profile (visual kinds: $kinds)", async ({ kinds }) => {
    const pages = [
      { page: 1, text: "Chapter 1: Geometry", visualKinds: [...kinds] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" },
    ];
    const segmentData = new Map<string, PdfSegment>();
    const first = await runPdfScenario({ pages, segmentData, savedChunks: [{
      page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: "old/key",
      text: "[原生提取]\nChapter 1: Geometry\n\n[视觉转写与描述]\nAnswer Key\nx = 3.",
    }] });
    expect(first.publishedChunks.map(chunk => chunk.page)).toEqual([1, 3]);

    const cached = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks });
    expect(cached.requests).toEqual([{ start: 1 }]);
    expect(cached.publishedChunks).toEqual(first.publishedChunks);

    vi.stubEnv("PARSER_OCR_MODEL_DIR", process.env.PARSER_OCR_MODEL_DIR ? "" : "ocr-profile-test");
    try {
      const changedProfile = await runPdfScenario({ pages, segmentData, savedChunks: cached.publishedChunks,
        segmentPages: 1, failedStarts: [1],
      });
      expect(changedProfile.requests.slice(0, 2)).toEqual([{ start: 1 }, { start: 1 }]);
      expect(changedProfile.preservePages).toEqual([]);
      expect(changedProfile.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps unknown pages separate from confirmed seals and replaces a confirmed marker after clean raw Vision", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "Public page." }, { page: 2, text: "", visualKinds: ["scan" as const] },
      { page: 3, text: "5 units." }, { page: 4, text: "Chapter 2: Vectors" }];
    const failed = await runPdfScenario({ pages, segmentData, segmentPages: 1, failedStarts: [1],
      recognizePage: async () => ({ text: "5 units.", imageObjectKey: "vision/unknown" }),
    });
    expect(failed.publishedChunks.map(chunk => chunk.page)).toEqual([4]);
    expect(segmentData.get("pdf-publication-page-seal-v1/2-2")).toMatchObject({
      state: "ready", pages: [{ hadSealedContent: false, publicationSealUnknown: true }],
    });
    expect(segmentData.has("pdf-publication-page-seal-v1/3-3")).toBe(false);

    const sealed = await runPdfScenario({ pages, segmentData, segmentPages: 1,
      recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "vision/sealed" }),
    });
    expect(sealed.publishedChunks.map(chunk => chunk.page)).toEqual([1, 4]);
    expect(segmentData.get("pdf-publication-page-seal-v1/2-2")).toMatchObject({
      state: "ready", pages: [{ hadSealedContent: true, sectionSealedAtEnd: true }],
    });
    // Recovery also needs a fresh native parse of the previously sealed continuation.
    segmentData.delete(pdfParserProfile() + "/3-3");
    const recovered = await runPdfScenario({ pages, segmentData, segmentPages: 1,
      recognizePage: async () => ({ text: "Chapter 1: Geometry", imageObjectKey: "vision/recovered" }),
    });
    expect(recovered.publishedChunks.map(chunk => chunk.page)).toEqual([1, 2, 3, 4]);
    expect(segmentData.has("pdf-publication-page-seal-v1/2-2")).toBe(false);
    const failedAgain = await runPdfScenario({ pages, segmentData, savedChunks: recovered.publishedChunks,
      segmentPages: 2, failedStarts: [1],
    });
    expect(failedAgain.preservePages).toEqual([1, 2]);
    expect(failedAgain.publishedChunks.map(chunk => chunk.page)).toEqual([3, 4]);
  });

  it.each(["live", "archived"] as const)("keeps %s Vision within a native-sealed public prefix", async origin => {
    const stem = "Exercise 1: Solve x + 2 = 5.";
    const header = "【原图忠实转写，尚需核对】";
    for (const boundary of ["", "\nModel answer: x = 3."]) {
      const vision = [header, stem, "x = 3." + boundary, "【图表观察描述，非原文或解答】", "Shows the answer."].join("\n");
      const result = await runPdfScenario({
        pages: [{ page: 1, text: stem, visualKinds: ["picture"], hadSealedContent: true, inlineSealedAtEnd: false }],
        ...(origin === "live" ? { recognizePage: async () => ({ text: vision, imageObjectKey: "answer" }) } : {
          savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: "answer",
            text: "[原生提取]\n" + stem + "\n\n[视觉转写与描述]\n" + vision }],
        }),
      });
      expect(result.publishedChunks).toMatchObject([{
        text: boundary ? "[原生提取]\n" + stem + "\n\n[视觉转写与描述]\n" + header + "\n" + stem : stem,
        imageObjectKey: null,
      }]);
    }
  });

  it.each(["live", "archived"] as const)("rejects unaligned answer lines in %s Vision on a native-sealed page", async origin => {
    const stem = "Exercise 1: Solve x + 2 = 5.";
    for (const body of [
      "Exercise 1. Solve x + 2 = 5.\nx = 3.\nModel answer: x = 3.",
      "x = 3.\n" + stem + "\nModel answer: x = 3.",
    ]) {
      const vision = "【原图忠实转写，尚需核对】\n" + body;
      const result = await runPdfScenario({
        pages: [{ page: 1, text: stem, visualKinds: ["picture"], hadSealedContent: true, inlineSealedAtEnd: false }],
        ...(origin === "live" ? { recognizePage: async () => ({ text: vision, imageObjectKey: "answer" }) } : {
          savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: "answer",
            text: "[原生提取]\n" + stem + "\n\n[视觉转写与描述]\n" + vision }],
        }),
      });
      expect(result.publishedChunks).toMatchObject([{ page: 1, imageObjectKey: null }]);
      expect(result.publishedChunks[0]?.text).toContain(stem);
      expect(result.publishedChunks[0]?.text).not.toContain("x = 3.");
      expect(result.publishedChunks[0]?.text).not.toContain("Exercise 1.");
    }
  });

  it.each(["live", "archived"] as const)("aligns %s Vision even when it opens with a public chapter heading", async origin => {
    const chapter = "Chapter 1: Geometry";
    const vision = chapter + "\nx = 3.\nAnswer: x = 3.";
    const result = await runPdfScenario({
      pages: [{ page: 1, text: chapter, visualKinds: ["picture"], hadSealedContent: true, inlineSealedAtEnd: false }],
      ...(origin === "live" ? { recognizePage: async () => ({ text: vision, imageObjectKey: "answer" }) } : {
        savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: "answer",
          text: "[原生提取]\n" + chapter + "\n\n[视觉转写与描述]\n" + vision }],
      }),
    });
    expect(result.publishedChunks).toMatchObject([{
      page: 1, text: "[原生提取]\n" + chapter + "\n\n[视觉转写与描述]\n" + chapter, imageObjectKey: null,
    }]);
  });

  it.each([
    ["Chapter 1: Geometry\nAnswer Key", "Chapter 1: Geometry\nx = 3.", true],
    ["Chapter 1: Geometry\nAnswer Key", "Chapter 1: Geometry", true],
    ["Answer Key", "Chapter 1: Geometry\nx = 3.", false],
    ["Answer Key", "Chapter 1: Geometry\nThis section introduces triangles.\n**Ans**wers to Exercises 1–5\nx = 3.", false],
    ["Answer Key", "Exercise 1: Solve x + 2 = 5.\nx = 3.", false],
    ["Answer Key", "Exercise 1: Solve x + 2 = 5.\nx = 3.\nAnswer: x = 3.", false],
    ["Answer Key", "# Page 1 of 3", false],
    ["Answer Key", "# Geometry", false],
    ["Answer Key", "Chapter 1 (continued)", false],
    ["Answer Key", "# Section 2: Geometry (cont’d)", false],
    ["Answer Key", "Chapter 1", false],
    ["Answer Key", "Section 2", false],
    ["Answer Key", "Chapter 1 (page 2 of 3)", false],
    ["Answer Key", "# Chapter 1: Geometry (p. 4)", false],
    ["Answer Key", "Chapter 1: Geometry (第 2 页)", false],
  ] as const)("keeps the confirmed Vision seal from %j when retrying with %j", async (firstVision, retryVision, publicPrefix) => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
    const first = await runPdfScenario({ pages, segmentData,
      recognizePage: async () => ({ text: firstVision, imageObjectKey: "full-page" }),
    });
    const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks,
      recognizePage: async () => ({ text: retryVision, imageObjectKey: "full-page" }),
    });
    expect(retry.publishedChunks.map(({ page }) => page)).toEqual([3]);
    expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
      state: "ready", pages: [{ hadSealedContent: true, sectionSealedAtEnd: true, publicationSealHadPublicPrefix: publicPrefix }],
    });
  });

  it("commits a verified reopening only with successful chunk publication", async () => {
    const key = "pdf-publication-page-seal-v1/1-1";
    const section = { page: 1, text: "", imagePath: null, hadSealedContent: true, sectionSealedAtEnd: true,
      publicationSealHadPublicPrefix: false, publicationSealCommitted: false, visualKinds: ["scan" as const] };
    const segmentData = new Map<string, PdfSegment>([[key, { state: "ready", pages: [section] }]]);
    const options = { segmentData, pages: [
      { page: 1, text: "", visualKinds: ["scan" as const] }, { page: 2, text: "Public continuation." },
    ], recognizePage: async () => ({ text: "Chapter 2: Vectors", imageObjectKey: "vision/chapter" }) };
    await expect(runPdfScenario({ ...options, beforePublish: () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(segmentData.get(key)).toEqual({ state: "ready", pages: [section] });
    await expect(runPdfScenario(options)).resolves.toMatchObject({ publishedChunks: [{ page: 1 }, { page: 2 }] });
    expect(segmentData.has(key)).toBe(false);
  });

  it.each([
    "Recovered second page.\nThe chapter introduces triangles.",
    "Chapter 2: Geometry\nThis section introduces triangles.",
  ])("re-extracts a failed native page after an interrupted retry with %j", async recoveredText => {
    const settled = pdfParserProfile() + "/publication-failure-settled-2/2-2";
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "Public first page." }, { page: 2, text: recoveredText },
      { page: 3, text: "Public continuation." }];
    const options = { pages, segmentData, segmentPages: 1 };
    const first = await runPdfScenario({ ...options, failedStarts: [2] });
    expect(first.publishedChunks.map(page => page.page)).toEqual([1]);
    await expect(runPdfScenario({ ...options, savedChunks: first.publishedChunks, beforePublish: () => {
      throw new Error("interrupted before chunks commit");
    } })).rejects.toThrow("interrupted before chunks commit");
    expect(segmentData.get(settled)).toMatchObject({ state: "ready" });
    expect(segmentData.has("pdf-publication-page-seal-v1/2-2")).toBe(false);

    const retry = await runPdfScenario({ ...options, savedChunks: first.publishedChunks });
    expect(retry.requests).toEqual([{ start: 2 }]);
    expect(retry.publishedChunks.map(({ text }) => text)).toEqual(pages.map(({ text }) => text));
    expect(retry.pdfWarning).toBeUndefined();
    expect(segmentData.has(settled)).toBe(false);
    expect(segmentData.get(pdfParserProfile() + "/2-2")).toMatchObject({ state: "ready" });
    const again = await runPdfScenario({ ...options, savedChunks: retry.publishedChunks });
    expect(again.requests).toEqual([]);
    expect(again.publishedChunks).toEqual(retry.publishedChunks);
    expect(again.pdfWarning).toBeUndefined();
  });

  it("re-extracts a multiline native chapter after seal recovery was interrupted before publication", async () => {
    const key = "pdf-publication-page-seal-v1/2-2";
    const segmentData = new Map<string, PdfSegment>();
    const publicPages = [
      { page: 1, text: "Public first page." },
      { page: 2, text: "Chapter 2: Geometry\nThis section introduces triangles." },
      { page: 3, text: "Public continuation." },
    ];
    const first = await runPdfScenario({ segmentData, segmentPages: 1,
      pages: [publicPages[0]!, { page: 2, text: "Answer Key" }, publicPages[2]!],
    });
    expect(first.publishedChunks.map(({ page }) => page)).toEqual([1]);

    const options = { segmentData, segmentPages: 1, pages: publicPages, savedChunks: first.publishedChunks };
    await expect(runPdfScenario({ ...options, beforePublish: () => {
      throw new Error("interrupted before chunks commit");
    } })).rejects.toThrow("interrupted before chunks commit");
    expect(segmentData.get(key)).toMatchObject({ pages: [{ sectionSealedAtEnd: true }] });

    const retry = await runPdfScenario(options);
    expect(retry.requests).toEqual([{ start: 2 }]);
    expect(retry.publishedChunks.map(({ text }) => text)).toEqual(publicPages.map(({ text }) => text));
    expect(retry.pdfWarning).toBeUndefined();
    expect(segmentData.has(key)).toBe(false);
  });

  it("recovers a confirmed Vision seal from a substantive multiline chapter", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] },
      { page: 2, text: "The next page continues the geometric construction." }];
    await runPdfScenario({ segmentData, pages, recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "answer" }) });
    const text = "Chapter 2: Geometry\nThis section introduces triangles.";
    const retry = await runPdfScenario({ segmentData, pages, recognizePage: async () => ({ text, imageObjectKey: "geometry" }) });
    expect(retry.publishedChunks).toMatchObject([
      { page: 1, text: "[视觉转写与描述]\n" + text }, { page: 2, text: pages[1]!.text },
    ]);
    expect(retry.pdfWarning).toBeUndefined();
  });

  it.each([false, true])("recovers only a scan's own uncertainty with fresh prose (blocked predecessor: %s)", async blocked => {
    const pages = [{ page: 1, text: blocked ? "" : "Public first page.", visualKinds: blocked ? ["scan" as const] : [] },
      { page: 2, text: "", visualKinds: ["scan" as const] }, { page: 3, text: "Chapter 3: Probability" }];
    const segmentData = new Map<string, PdfSegment>();
    const first = await runPdfScenario({ pages, segmentData, segmentPages: 1 });
    const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks, segmentPages: 1,
      recognizePage: async ({ physicalPage }) => physicalPage === 2
        ? { text: "Recovered second page", imageObjectKey: "recognized/2" } : null });
    expect(retry.publishedChunks.find(page => page.page === 2)).toEqual(blocked ? undefined
      : expect.objectContaining({ text: "[视觉转写与描述]\nRecovered second page", imageObjectKey: "recognized/2" }));
  });

  it("replays a mixed-page seal using only native-aligned Vision lines", async () => {
    const chapter = "Chapter 1: Geometry";
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: chapter, visualKinds: ["picture" as const] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
    const first = await runPdfScenario({ pages, segmentData,
      recognizePage: async () => ({ text: chapter + "\nAnswer Key", imageObjectKey: "full-page" }),
    });
    const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks,
      recognizePage: async () => ({ text: chapter + "\nx = 3.\nAnswer: x = 3.", imageObjectKey: "full-page" }),
    });
    expect(retry.publishedChunks.map(({ page, text, imageObjectKey }) => [page, text, imageObjectKey])).toEqual([
      [1, "[原生提取]\n" + chapter + "\n\n[视觉转写与描述]\n" + chapter, null],
      [3, "Chapter 2: Vectors", null],
    ]);
  });

  it.each(["# Page 2 of 3", "## OCR text for page 2", "# Chapter 1: Geometry (continued)", "# Section 2", "# 123", "# XVII", "[unreadable]"])(
    "keeps an inherited inline seal through the Vision header %j", async text => {
      const result = await runPdfScenario({ segmentPages: 1, pages: [
        { page: 1, text: "Exercise 1: Find x.\nAnswer: x =" },
        { page: 2, text: "", visualKinds: ["scan"] },
        { page: 3, text: "5 units." },
        { page: 4, text: "Chapter 2: Vectors" },
      ], recognizePage: async () => ({ text, imageObjectKey: "full-page" }) });
      expect(result.publishedChunks.map(({ page }) => page)).toEqual([1, 4]);
      expect(result.requests.find(({ start }) => start === 3)?.seed).toBe("inline_sealed");
    },
  );

  it.each(["123", "# Page 1 of 3", "[unreadable]"])(
    "withholds an unverified picture and its continuation when native text is %j", async text => {
      const segmentData = new Map<string, PdfSegment>();
      const result = await runPdfScenario({ segmentData, segmentPages: 1, pages: [
        { page: 1, text, visualKinds: ["picture"] },
        { page: 2, text: "5 units." },
        { page: 3, text: "Chapter 2: Vectors" },
      ], recognizePage: async () => ({ text: "[illegible]", imageObjectKey: "archived/full-page" }) });
      expect(result.publishedChunks.some(chunk => chunk.imageObjectKey || chunk.page === 2)).toBe(false);
      expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
        state: "ready", pages: [{ visualKinds: ["picture"], publicationSealUnknown: true }],
      });
    },
  );

  it.each(["empty", "single exception", "batch exception", "abort", "conflict"])(
    "fences an unverified visual page before rejecting %s recognition", async failure => {
      const segmentData = new Map<string, PdfSegment>();
      const error = new Error("recognition failed");
      if (failure === "abort") error.name = "AbortError";
      if (failure === "conflict") Object.assign(error, { code: "CONFLICT" });
      const options = failure === "batch exception"
        ? { recognizePages: async function* () { yield Promise.reject(error); } }
        : { recognizePage: async () => {
          if (failure === "empty") return { text: "", imageObjectKey: "full-page" };
          throw error;
        } };
      await expect(runPdfScenario({ ...options, segmentData, pages: [
        { page: 1, text: "123", visualKinds: ["picture"] }, { page: 2, text: "5 units." },
      ] })).rejects.toThrow(failure === "empty" ? "no readable content" : "recognition failed");
      const marker = segmentData.get("pdf-publication-page-seal-v1/1-1");
      if (failure === "abort" || failure === "conflict") expect(marker).toBeUndefined();
      else expect(marker).toMatchObject({ state: "ready", pages: [{
        publicationSealUnknown: true, publicationSealCommitted: false,
      }] });
    },
  );

  it.each(["Transcription for page 1", "# Page 1 of 3", "【图表观察描述，非原文或解答】\nA red curve.",
    "[illegible]", "[unreadable]", "[blank]", "123", "# 123", "XVII", "[图片描述]\nA red curve."])(
    "records scan uncertainty and withholds the image for Vision-only %j", async text => {
      const segmentData = new Map<string, PdfSegment>();
      const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] },
        { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
      const recognizePage = async () => ({ text, imageObjectKey: "full-page" });
      const first = await runPdfScenario({ pages, segmentData, recognizePage });
      expect(first.publishedChunks.some(chunk => chunk.imageObjectKey || chunk.page === 2)).toBe(false);
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
        state: "ready", pages: [{ publicationSealUnknown: true }],
      });
      const retry = await runPdfScenario({ pages, segmentData, recognizePage, savedChunks: first.publishedChunks });
      expect(retry.publishedChunks.map(({ page }) => page)).toEqual([3]);
    },
  );

  it.each(["Exercise 1: Solve x.\nx = 3.", "Exercise 1: Solve x.\nx = 3.\nAnswer: x = 3.",
    "# Geometry", "# Transcription for page 1 of 3"])(
    "withholds %j when replaying an uncertain scan without a substantive section heading", async text => {
      const segmentData = new Map<string, PdfSegment>();
      const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] },
        { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
      const first = await runPdfScenario({ pages, segmentData });
      const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks,
        recognizePage: async () => ({ text, imageObjectKey: "unverified" }),
      });
      expect(retry.publishedChunks.map(({ page }) => page)).toEqual([3]);
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
        state: "ready", pages: [{ publicationSealUnknown: true }],
      });
      const cached = await runPdfScenario({ pages, segmentData, savedChunks: retry.publishedChunks });
      expect(cached.publishedChunks.map(({ page }) => page)).toEqual([3]);
    },
  );

  it("revalidates a stale non-OCR cache before it can clear a newer uncertainty fence", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const tail = [{ page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
    vi.stubEnv("PARSER_OCR_MODEL_DIR", "");
    try {
      const initial = await runPdfScenario({ pages: [{ page: 1, text: "An old extraction claimed this was public prose." }, ...tail],
        segmentData, segmentPages: 1 });
      expect(initial.publishedChunks.map(({ page }) => page)).toEqual([1, 2, 3]);

      vi.stubEnv("PARSER_OCR_MODEL_DIR", "ocr-test");
      const uncertain = await runPdfScenario({ pages: [{ page: 1, text: "��" }, ...tail], segmentPages: 1,
        segmentData, savedChunks: initial.publishedChunks });
      expect(uncertain.publishedChunks.map(({ page }) => page)).toEqual([1, 3]);
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({ pages: [{ publicationSealUnknown: true }] });

      vi.stubEnv("PARSER_OCR_MODEL_DIR", "");
      const retry = await runPdfScenario({ pages: [{ page: 1, text: "123", visualKinds: ["picture"] }, ...tail], segmentPages: 1,
        segmentData, savedChunks: uncertain.publishedChunks });
      expect(retry.requests).toEqual([{ start: 1 }]);
      expect(retry.publishedChunks.every(({ page, imageObjectKey }) => page !== 2 && imageObjectKey === null)).toBe(true);
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({ pages: [{ publicationSealUnknown: true }] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps confirmed seals when switching back to cached non-OCR pages", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "x = 3." }, { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
    vi.stubEnv("PARSER_OCR_MODEL_DIR", "");
    try {
      const initial = await runPdfScenario({ pages, segmentData });
      expect(initial.publishedChunks.map(chunk => chunk.page)).toEqual([1, 2, 3]);
      vi.stubEnv("PARSER_OCR_MODEL_DIR", "ocr-test");
      const sealed = await runPdfScenario({ pages: [{ ...pages[0]!, visualKinds: ["picture"] }, ...pages.slice(1)], segmentData,
        savedChunks: initial.publishedChunks,
        recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "answer" }),
      });
      expect(sealed.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
      const key = "pdf-publication-page-seal-v1/1-1";
      const marker = segmentData.get(key);
      expect(marker?.state).toBe("ready");
      if (marker?.state === "ready") delete marker.pages[0]!.visualKinds;
      vi.stubEnv("PARSER_OCR_MODEL_DIR", "");
      const replay = await runPdfScenario({ pages, segmentData, savedChunks: sealed.publishedChunks });
      expect(replay.requests).toEqual([{ start: 1 }, { start: 2, seed: "section_sealed" }, { start: 3, seed: "section_sealed" }]);
      expect(replay.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
        state: "ready", pages: [{ hadSealedContent: true, sectionSealedAtEnd: true }],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps an earlier Vision seal when a retry returns only a diagram description", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "x = 3.", visualKinds: ["picture" as const] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
    const first = await runPdfScenario({ pages, segmentData,
      recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "answer" }),
    });
    const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks,
      recognizePage: async () => ({ text: "【图表观察描述，非原文或解答】\nA red curve.", imageObjectKey: "full-page" }),
    });
    expect(retry.requests).toEqual([{ start: 1 }]);
    expect(retry.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
    expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
      state: "ready", pages: [{ hadSealedContent: true, sectionSealedAtEnd: true }],
    });
  });

  it.each([1, 2])("carries an unreadable scan across %i-page ranges until a public structural heading", async segmentPages => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }, { page: 4, text: "Public continuation." }];
    const result = await runPdfScenario({ pages, segmentData, segmentPages });
    expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([3, 4]);
    expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
    expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
      state: "ready", pages: [{ hadSealedContent: false, publicationSealUnknown: true }],
    });
    const retry = await runPdfScenario({ pages, segmentData, segmentPages, savedChunks: result.publishedChunks });
    expect(retry.requests).toEqual([{ start: 1 }]);
    expect(retry.publishedChunks).toEqual(result.publishedChunks);
  });

  it.each(["5 units.", "Transcription for page 2", "# Transcription for page 2", "# Page 2",
    "# Transcription for page 2 of 3", "# Page 2/10", "# Slide 2 - 5", "# Cached transcription of page 2",
    "# OCR text for page 2", "# Scanned page 2", "# 第 2 页", "# 第 2 / 3 页",
  ])("withholds cached %j after a skipped scan", async transcription => {
    const result = await runPdfScenario({ segmentPages: 1, pages: [
      { page: 1, text: "", visualKinds: ["scan"] }, { page: 2, text: "", visualKinds: ["scan"] },
      { page: 3, text: "5 units." },
    ], savedChunks: [{ page: 3, text: "5 units.", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }],
    recognizePages: async function* (inputs) {
      for (const input of inputs) {
        yield input.physicalPage === 1 ? null : {
          text: "【原图忠实转写，尚需核对】\n" + transcription, imageObjectKey: "archived-unheaded",
        };
      }
    } });
    expect(result.publishedChunks).toEqual([]);
    expect(result.preservePages).toEqual([]);
    expect(result.allowSealedEmpty).toBe(true);
  });

  it("ends persisted scan uncertainty when Vision supplies a public structural heading", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] }, { page: 2, text: "", visualKinds: ["scan" as const] },
      { page: 3, text: "Public continuation." }, { page: 4, text: "Chapter 2: Vectors" }];
    const first = await runPdfScenario({ pages, segmentData, segmentPages: 1 });
    expect(first.publishedChunks.map(chunk => chunk.page)).toEqual([4]);
    const recovered = await runPdfScenario({ pages, segmentData, segmentPages: 1, savedChunks: first.publishedChunks,
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          yield input.physicalPage === 1 ? null : { text: "Chapter 1: Geometry", imageObjectKey: "new-section" };
        }
      },
    });
    expect(recovered.publishedChunks.map(chunk => chunk.page)).toEqual([2, 3, 4]);
    expect(segmentData.has("pdf-publication-page-seal-v1/2-2")).toBe(false);
  });

  it("carries uncertainty past an unverified low-quality native page", async () => {
    const result = await runPdfScenario({ segmentPages: 1, pages: [
      { page: 1, text: "\uFFFD".repeat(12), visualKinds: [] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" },
    ] });
    expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([1, 3]);
    expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
  });

  it.each([1, 2])("carries inferred scan and replacement-character uncertainty across %i-page ranges", async segmentPages => {
    for (const first of [{ page: 1, text: "" }, { page: 1, text: "\uFFFD", visualKinds: [] },
      { page: 1, text: "\uFFFD\uFFFD", visualKinds: [] }]) {
      const segmentData = new Map<string, PdfSegment>();
      const pages = [first, { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }];
      const result = await runPdfScenario({ segmentPages, segmentData, pageCount: pages.length,
        extractRange: (start, end) => JSON.stringify({ pages: pages.slice(start - 1, end).map(page => ({ ...page, imagePath: null })) }),
      });
      expect(result.publishedChunks.map(chunk => chunk.page)).not.toContain(2);
      expect(result.publishedChunks.at(-1)?.page).toBe(3);
      expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
      expect(segmentData.get("pdf-publication-page-seal-v1/1-1")).toMatchObject({
        state: "ready", pages: [{ hadSealedContent: false, publicationSealUnknown: true }],
      });
    }
  });

  it.each(["Chapter 3: Worked Example", "Section 2.1: Worked Example 2", "Unit 2 Worked Example 3"])(
    "carries worked-example state after %s", async heading => {
      const result = await runPdfScenario({ segmentPages: 1, pages: [
        { page: 1, text: heading }, { page: 2, text: "Solution:\nx = 3." },
      ] });
      expect(result.requests[1]).toEqual({ start: 2, workedExample: true });
      expect(result.publishedChunks.map(chunk => chunk.text)).toEqual([heading, "Solution:\nx = 3."]);
    },
  );

  it("publishes the current native text and clears its marker after a clean recovery", async () => {
    const segmentData = new Map<string, PdfSegment>([["pdf-publication-page-seal-v1/1-1", {
      state: "ready", pages: [{ page: 1, text: "", imagePath: null, hadSealedContent: true, sectionSealedAtEnd: true }],
    }]]);
    const result = await runPdfScenario({ segmentData, pages: [{ page: 1, text: "Chapter 1: Public recovered section" }], savedChunks: [{
      page: 1, slideLabel: null, startMs: null, endMs: null, text: "5 units.", imageObjectKey: null,
    }] });
    expect(result.publishedChunks.map(({ text }) => text)).toEqual(["Chapter 1: Public recovered section"]);
    expect(segmentData.has("pdf-publication-page-seal-v1/1-1")).toBe(false);
  });

  it("keeps a legacy seal marker when fresh native extraction only supplies unheaded text", async () => {
    const marker: PdfSegment = {
      state: "ready", pages: [{ page: 1, text: "", imagePath: null, hadSealedContent: true, sectionSealedAtEnd: true }],
    };
    const key = "pdf-publication-page-seal-v1/1-1";
    const segmentData = new Map([[key, marker]]);
    const result = await runPdfScenario({ segmentData, pages: [
      { page: 1, text: "5 units." }, { page: 2, text: "6 units." }, { page: 3, text: "Chapter 2: Vectors" },
    ] });
    expect(result.publishedChunks.map(({ page }) => page)).toEqual([3]);
    expect(segmentData.get(key)).toMatchObject(marker);
  });

  it.each([false, true])("withdraws old answers when a failure follows an unreadable scan (scan also fails: %s)", async scanFails => {
    const pages = [{ page: 1, text: "", visualKinds: ["scan" as const] },
      { page: 2, text: "5 units." }, { page: 3, text: "6 units." }, { page: 4, text: "Chapter 2: Vectors" }];
    const result = await runPdfScenario({ pages, segmentPages: 1, failedStarts: scanFails ? [1, 2] : [2],
      savedChunks: [{ ...pages[1]!, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }],
    });
    expect(result.preservePages).toEqual([]);
    expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([4]);
  });

  it.each(["Transcription for page 1", "[视觉转写与描述]\n[图片描述]\nA red curve.", undefined])(
    "records a failed boundary before publication with an unverified archived scan %j", async text => {
      const segmentData = new Map<string, PdfSegment>();
      const published = text ? [{ ...{ page: 1, slideLabel: null, startMs: null, endMs: null },
        text, imageObjectKey: "old/image" }] : [];
      const result = await runPdfScenario({ segmentData, failedStarts: [1], segmentPages: 1, savedChunks: published,
        pages: [{ page: 1, text: "" }, { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }],
        beforePublish: () => {
          expect(segmentData.has("pdf-publication-page-seal-v1/1-1")).toBe(false);
          expect(segmentData.get(pdfParserProfile() + "/publication-failure-pending-1/1-1"))
            .toEqual({ state: "failed", errorCode: "conversion_failed" });
        } });
      expect(result.preservePages).toEqual([]);
      expect(result.publishedChunks.map(page => page.page)).toEqual([3]);
    },
  );

  it("withdraws an archived generic Markdown heading and its answer after an unreadable predecessor", async () => {
    const result = await runPdfScenario({ segmentPages: 1, failedStarts: [2], pages: [
      { page: 1, text: "", visualKinds: ["scan"] }, { page: 2, text: "5 units." },
      { page: 3, text: "Chapter 2: Vectors" },
    ], savedChunks: [{ page: 2, text: "# Geometry\n5 units.", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
    expect(result.preservePages).toEqual([]);
    expect(result.publishedChunks.map(({ page }) => page)).toEqual([3]);
  });

  it("requires a segment store before saved prose can clear an unknown failed page", async () => {
    const result = await runPdfScenario({ withoutSegments: true, segmentPages: 1, failedStarts: [1],
      pages: [{ page: 1, text: "Public prefix." }, { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }],
      savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: "Public prefix.", imageObjectKey: null }],
    });
    expect(result.preservePages).toEqual([]);
    expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([3]);
  });

  it("carries a Vision section seal across consecutive failed ranges and withdraws both old answers", async () => {
    const result = await runPdfScenario({ segmentPages: 1, failedStarts: [2, 3],
      pages: [{ page: 1, text: "", visualKinds: ["scan"] }, { page: 2, text: "5 units." }, { page: 3, text: "6 units." },
        { page: 4, text: "Chapter 3" }, { page: 5, text: "Chapter 2: Vectors" }],
      savedChunks: [2, 3].map(page => ({ page, slideLabel: null, startMs: null, endMs: null, text: `${page + 3} units.`, imageObjectKey: null })),
      recognizePage: async () => ({ text: "Answer Key", imageObjectKey: "vision/key" }),
    });
    expect(result.requests).toEqual([{ start: 1 }, ...[2, 2, 3, 3, 4, 5].map(start => ({ start, seed: "section_sealed" }))]);
    expect(result.preservePages).toEqual([]);
    expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([5]);
  });

  it("rechecks archived answers and continuations even when the failed range had no parser seal", async () => {
    const saved = ["Answer Key\n5 units.", "6 units."].map((text, index) => ({ page: index + 1,
      slideLabel: null, startMs: null, endMs: null, text, imageObjectKey: null }));
    const result = await runPdfScenario({ segmentPages: 2, failedStarts: [1], savedChunks: saved,
      pages: [...saved, { page: 3, text: "7 units." }, { page: 4, text: "Chapter 2: Vectors" }],
    });
    expect(result.preservePages).toEqual([]);
    expect(result.publishedChunks.map(chunk => chunk.page)).toEqual([4]);
    const totalFailure = await runPdfScenario({ pages: saved, segmentPages: 2, failedStarts: [1], savedChunks: saved });
    expect(totalFailure).toMatchObject({ allowSealedEmpty: true, preservePages: [], publishedChunks: [], pdfWarning: { code: "PARSE_PARTIAL" } });
  });

  it.each(["Sample solution: x = 4.", "Sample solution\nx = 4.", "Model answer\nx = 4.", "Reference answer\nx = 4."])(
    "seals the solution label %s and keeps worked-example solutions public", async answer => {
      const exercise = "Exercise 1: Find x.";
      const example = "Worked Example 2: Find y.\nSample solution\ny = 7.";
      const result = await runPdfScenario({ pages: [{ page: 1, text: `${exercise}\n${answer}` }, { page: 2, text: example }] });
      expect(result.publishedChunks.map(chunk => chunk.text)).toEqual([exercise, example]);
    },
  );

  it.each([
    ["【图表观察描述，非原文或解答】", true], ["【图表观察描述，非原文或解答】", false],
    ["【识别不确定，不能据此判定正确】", true], ["【识别不确定，不能据此判定正确】", false],
  ] as const)("withholds a Vision answer in %s (public transcription: %s)", async (header, hasTranscription) => {
    const transcript = "【原图忠实转写，尚需核对】\nExercise 1: Find x.";
    const result = await runPdfScenario({ pages: [{ page: 1, text: "", visualKinds: ["scan"] },
      { page: 2, text: "5 units." }, { page: 3, text: "Chapter 2: Vectors" }], segmentPages: 1,
      recognizePage: async () => ({ text: `${hasTranscription ? `${transcript}\n` : ""}${header}\nModel answer: x =\n${header}\n5 units`, imageObjectKey: "vision/answer" }),
    });
    expect(result.requests[1]).toEqual({ start: 2, seed: "inline_sealed" });
    expect(result.publishedChunks.map(({ page, text, imageObjectKey }) => ({ page, text, imageObjectKey }))).toEqual([
      ...(hasTranscription ? [{ page: 1, text: `[视觉转写与描述]\n${transcript}`, imageObjectKey: null }] : []),
      { page: 3, text: "Chapter 2: Vectors", imageObjectKey: null },
    ]);
  });

  it.each(["live", "saved"] as const)("redacts unheaded native and transcription text when %s Vision detects an answer", async origin => {
    const answer = "x = 3.";
    const chapter = "Chapter 2: Vectors";
    const header = "【原图忠实转写，尚需核对】";
    const aux = "【图表观察描述，非原文或解答】";
    const imageObjectKey = "vision/mixed-answer";
    const exercise = "Exercise 1: Solve x + 2 = 5.";
    for (const text of [answer, exercise, [exercise, answer].join("\n")]) {
      for (const vision of [
        answer + "\nModel answer: " + answer,
        [header, answer, aux, "Model answer: " + answer].join("\n"),
        [header, aux, "Model answer: " + answer].join("\n"),
      ]) {
        const result = await runPdfScenario({ pages: [{ page: 1, text, visualKinds: ["picture"] }, { page: 2, text: chapter }],
          ...(origin === "live" ? { recognizePage: async () => ({ text: vision, imageObjectKey }) } : {
            savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey,
              text: "[原生提取]\n" + text + "\n\n[视觉转写与描述]\n" + vision }],
          }),
        });
        expect(result.publishedChunks.map(({ text }) => text)).toEqual(text === answer ? [chapter] : [exercise, chapter]);
        expect(result.publishedChunks.every(chunk => chunk.imageObjectKey === null)).toBe(true);
      }
    }
  });

  it("keeps the transcription's public opener without its unheaded answer when auxiliary Vision confirms the seal", async () => {
    const exercise = "Exercise 1: Solve x + 2 = 5.";
    const header = "【原图忠实转写，尚需核对】";
    const result = await runPdfScenario({
      pages: [{ page: 1, text: "x = 3.", visualKinds: ["picture"] }],
      recognizePage: async () => ({
        text: [header, exercise, "x = 3.", "【识别不确定，不能据此判定正确】", "Model answer: x = 3."].join("\n"),
        imageObjectKey: "vision/mixed-answer",
      }),
    });
    expect(result.publishedChunks).toMatchObject([{
      text: ["[视觉转写与描述]", header, exercise].join("\n"), imageObjectKey: null,
    }]);
  });

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

  it("replaces contaminated oversized saved text with the fresh public text and strips rawCharStart/rawCharEnd spans", async () => {
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
    expect(sanitized.publishedChunks[0]?.text).toBe("Public fallback");

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

  it("Round-5: bounds Vision after trailing inline_sealed, keeps bold Section exits, and propagates savedSeal on degraded fallback", async () => {
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
    expect(inlineBeforeVision.publishedChunks[0]?.text).toBe("Find the vertex.");

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
    expect(boldSectionAndSavedInline.publishedChunks[1]?.text).toBe("Find the vertex.");

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

  it("seals an unmarked continuation after page 10 when the page's inline opener was already filtered", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." })),
        { page: 10, text: "Exercise 1: Find x.", hadSealedContent: true, inlineSealedAtEnd: true },
        { page: 11, text: "5 units." },
        { page: 12, text: "Chapter 2: Rings\nPublic chapter." },
      ],
    });
    expect(publishedChunks.map(chunk => chunk.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
  });

  it.each(["live", "saved"] as const)("carries an unfinished %s Vision answer across segment and cache boundaries", async visionSource => {
    const visionText = "【原图忠实转写，尚需核对】\nExercise 1: Find x.\nAnswer: x =\n";
    const result = await runPdfScenario({
      pages: [
        ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." })),
        { page: 10, text: "Exercise 1: Find x.", visualKinds: ["picture"] },
        { page: 11, text: "5 units." },
        { page: 12, text: "Chapter 2: Vectors" },
      ],
      ...(visionSource === "live" ? {
        recognizePages: async function* () { yield { text: visionText, imageObjectKey: "vision/page-10" }; },
      } : {
        savedChunks: [{
          page: 10, slideLabel: null, startMs: null, endMs: null, imageObjectKey: "vision/page-10",
          text: "[原生提取]\nExercise 1: Find x.\n\n[视觉转写与描述]\n" + visionText,
        }],
      }),
    });
    expect(result.requests).toEqual([{ start: 1 }, { start: 11, seed: "inline_sealed" }]);
    expect(result.publishedChunks.slice(-2).map(chunk => chunk.page)).toEqual([10, 12]);
    expect(result.publishedChunks.find(chunk => chunk.page === 10)?.text).toContain("Exercise 1: Find x.");
  });

  it("rereads raw Vision on a same-version retry after recognition becomes cache-only", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [
      { page: 1, text: "Public introduction.", visualKinds: ["picture" as const] },
      ...Array.from({ length: 18 }, (_, index) => ({ page: index + 2, text: "Public page." })),
      { page: 20, text: "Exercise 1: Find x.", visualKinds: ["picture" as const] },
      { page: 21, text: "5 units." },
      { page: 22, text: "Chapter 2: Vectors" },
    ];
    const cacheReads: number[] = [];
    async function* recognizePages(inputs: readonly ParseSourceVisualPageInput[], cacheOnly?: boolean) {
      for (const { physicalPage } of inputs) {
        if (physicalPage === 20) {
          expect(cacheOnly).toBe(true);
          cacheReads.push(physicalPage);
          yield { text: "【原图忠实转写，尚需核对】\nExercise 1: Find x.\nAnswer: x =", imageObjectKey: "vision/page-20" };
        } else {
          expect(physicalPage).toBe(1);
          expect(cacheOnly).toBe(false);
          yield null;
        }
      }
    }
    const first = await runPdfScenario({ pages, segmentData, recognizePages });
    expect(first.publishedChunks.find(chunk => chunk.page === 20)).toMatchObject({
      text: "[原生提取]\nExercise 1: Find x.\n\n[视觉转写与描述]\n【原图忠实转写，尚需核对】\nExercise 1: Find x.",
      imageObjectKey: null,
    });
    const seededRange = [...segmentData.keys()].find(key => key.endsWith("/from-inline_sealed/21-22"))!;
    expect(seededRange).toBeDefined();
    segmentData.delete(seededRange);

    const retry = await runPdfScenario({ pages, segmentData, recognizePages, savedChunks: first.publishedChunks });
    expect(cacheReads).toEqual([20, 20]);
    expect(retry.requests).toEqual([{ start: 11 }, { start: 21, seed: "inline_sealed" }]);
    expect(retry.publishedChunks.some(chunk => chunk.page === 21)).toBe(false);
    expect(retry.publishedChunks.at(-1)?.text).toBe("Chapter 2: Vectors");
  });

  it("reads newly eligible raw Vision from cache after a cached chapter reopens a sealed section", async () => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [
      { page: 1, text: "Public introduction.", visualKinds: ["picture" as const] },
      ...Array.from({ length: 10 }, (_, index) => ({ page: index + 2, text: "Public page." })),
      { page: 12, text: "Answer Key\n1. y = 4" },
      { page: 13, text: "", visualKinds: ["scan" as const] },
      { page: 14, text: "1. Find x.", visualKinds: ["picture" as const] },
      { page: 15, text: "5 units." },
    ];
    const vision = new Map([
      [13, { text: "Chapter 2: Vectors", imageObjectKey: "vision/chapter" }],
      [14, { text: "1. Find x.\nAnswer: x =", imageObjectKey: "vision/exercise" }],
    ]);
    const recognizePage = vi.fn(async ({ physicalPage }: ParseSourceVisualPageInput) => vision.get(physicalPage) ?? null);
    const batchCalls: Array<[number, boolean | undefined]> = [];
    async function* recognizePages(inputs: readonly ParseSourceVisualPageInput[], cacheOnly?: boolean) {
      for (const { physicalPage } of inputs) {
        batchCalls.push([physicalPage, cacheOnly]);
        if (physicalPage === 1) throw new OpeningModelRoutingError("Vision route unavailable");
        yield vision.get(physicalPage) ?? null;
      }
    }
    const first = await runPdfScenario({ pages, failedStarts: [1], segmentData, recognizePage, recognizePages });
    expect(first.publishedChunks).toEqual([
      expect.objectContaining({ page: 13, text: "[视觉转写与描述]\nChapter 2: Vectors", imageObjectKey: null }),
      expect.objectContaining({ page: 14, text: "[原生提取]\n1. Find x.\n\n[视觉转写与描述]\n1. Find x.", imageObjectKey: null }),
    ]);
    expect(batchCalls).toEqual([[13, false]]);
    expect(recognizePage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ physicalPage: 14 }));
    batchCalls.length = 0;
    recognizePage.mockClear();

    const retry = await runPdfScenario({ pages, segmentData, savedChunks: first.publishedChunks, recognizePage, recognizePages });
    expect(retry.publishedChunks.slice(-2)).toEqual(first.publishedChunks);
    expect(retry.publishedChunks.some(chunk => chunk.page === 15)).toBe(false);
    expect(batchCalls).toEqual([[1, false], [13, true], [14, true]]);
    expect(recognizePage).not.toHaveBeenCalled();
  });

  it.each([10, 11])("inspects a scan after a native answer key with %i-page segments", async segmentPages => {
    const lead = Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." }));
    for (const { scanText, nextText, opensChapter } of [
      { scanText: "Chapter 2: Vectors\nPublic lesson.", nextText: "Public continuation.", opensChapter: true },
      { scanText: "2. y = 4", nextText: "3. z = 5", opensChapter: false },
    ]) {
      const recognizePage = vi.fn(async () => ({ text: scanText, imageObjectKey: "vision/scan" }));
      const result = await runPdfScenario({
        pages: [
          ...lead,
          { page: 10, text: "", visualKinds: [], hadSealedContent: true, sectionSealedAtEnd: true },
          { page: 11, text: "", visualKinds: ["scan"], sectionSealedAtEnd: true },
          { page: 12, text: nextText },
        ],
        segmentPages,
        recognizePage,
      });
      expect(recognizePage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ physicalPage: 11, visualKinds: ["scan"] }));
      expect(result.requests[1]).toEqual(
        opensChapter && segmentPages === 11 ? { start: 12 } : { start: segmentPages + 1, seed: "section_sealed" },
      );
      expect(result.publishedChunks.filter(chunk => chunk.page >= 10).map(({ page, text, imageObjectKey }) => [page, text, imageObjectKey]))
        .toEqual(opensChapter ? [[11, "[视觉转写与描述]\n" + scanText, null], [12, nextText, null]] : []);
      expect(result.pdfWarning).toBeUndefined();
    }
  });

  it("falls back to saved Vision after a single-page route failure and reports missing OCR pages", async () => {
    const recognizePage = vi.fn(async () => null);
    const savedPage = { slideLabel: null, startMs: null, endMs: null, imageObjectKey: null };
    const result = await runPdfScenario({
      pages: [
        { page: 1, text: "Native prose." },
        { page: 2, text: "Local formula.", visualKinds: ["formula"] },
        { page: 3, text: "Local OCR.", visualKinds: ["scan"] },
        { page: 4, text: "", visualKinds: ["scan"] },
      ],
      recognizePage,
      savedChunks: [
        { ...savedPage, page: 3, text: "Local OCR." },
        { ...savedPage, page: 4, text: "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nCached readable text." },
      ],
    });
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(result.outcome).toEqual({ pages: 4, warnings: 3, degraded: true });
    expect(result.pdfWarning).toMatchObject({ message: "第 2–4 页未能识别，可以重新解析" });
    expect(result.publishedChunks.map(({ text }) => text)).toEqual([
      "Native prose.", "Local formula.", "Local OCR.", "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nCached readable text.",
    ]);
    expect(result.publishedChunks.at(-1)?.imageObjectKey).toBeNull();
  });

  it.each(["Answer:", "ANSWER:", "Correct Answer:", "Official Answer:", "Model Answer:", "Solution:",
    "答案：", "解答：", "【正确答案】", "【答案】", "Solution (continued)"])("keeps the label-only %s open at a page boundary", async label => {
    const result = await runPdfScenario({
      pages: [
        ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." })),
        { page: 10, text: "Exercise 1: Find x.\n" + label + "\n\n" },
        { page: 11, text: "5 units." },
        { page: 12, text: "Public explanation." },
      ],
    });
    expect(result.requests[1]).toEqual({ start: 11, seed: "inline_sealed" });
    expect(result.publishedChunks.slice(-2).map(chunk => [chunk.page, chunk.text]))
      .toEqual([[10, "Exercise 1: Find x."], [12, "Public explanation."]]);
  });

  it.each(["Model Answer:", "MODEL ANSWER 1.2 (CONTD.):"])("treats singular %s with a body as inline", async label => {
    for (const closed of [true, false]) {
      const result = await runPdfScenario({
        pages: [
          ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." })),
          { page: 10, text: "Exercise 1: Find x.\n" + label + (closed ? " x = 3." : " x =") },
          { page: 11, text: closed ? "Public explanation." : "5 units." },
          { page: 12, text: "Public example." },
        ],
      });
      expect(result.requests[1]).toEqual(closed ? { start: 11 } : { start: 11, seed: "inline_sealed" });
      expect(result.publishedChunks.slice(9).map(chunk => [chunk.page, chunk.text])).toEqual([
        [10, "Exercise 1: Find x."],
        ...(closed ? [[11, "Public explanation."]] : []),
        [12, "Public example."],
      ]);
    }
  });

  it.each(["Model answers", "Model Answers:", "Selected answers", "Official solutions", "Reference solutions", "Answer key", "Solutions manual"])(
    "keeps the standalone %s header section-sealed", async title => {
      const result = await runPdfScenario({ pages: [
        { page: 1, text: "Exercise 1: Find x.\n" + title + "\n1. x = 3." },
        { page: 2, text: "2. y = 4." },
        { page: 3, text: "Chapter 2: Vectors" },
      ] });
      expect(result.publishedChunks.map(chunk => [chunk.page, chunk.text]))
        .toEqual([[1, "Exercise 1: Find x."], [3, "Chapter 2: Vectors"]]);
    },
  );

  it.each(["答案：", "解答："])("keeps repeated %s labels inline within an exercise", async label => {
    const result = await runPdfScenario({ pages: [
      { page: 1, text: `练习\n（1）计算 x。\n${label}\n3.\n\n（2）计算 y。\n${label}\n4.` },
      { page: 2, text: "Public explanation." },
    ] });
    expect(result.publishedChunks.map(chunk => [chunk.page, chunk.text]))
      .toEqual([[1, "练习\n（1）计算 x。\n（2）计算 y。"], [2, "Public explanation."]]);
  });

  it.each(["【参考答案】", "【标准答案】", "【习题答案】", "【课后答案】", "参考答案", "标准答案", "答案："])(
    "seals all answers under %s across blank lines and pages", async title => {
      const result = await runPdfScenario({ pages: [
        ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Exercise 1: Find x." })),
        { page: 10, text: title + "\n1. x = 3.\n\n2. y = 4." },
        { page: 11, text: "5 units.\nChapter 2: Vectors" },
      ] });
      expect(result.requests[1]).toEqual({ start: 11, seed: "section_sealed" });
      expect(result.publishedChunks.slice(-2).map(chunk => [chunk.page, chunk.text]))
        .toEqual([[9, "Exercise 1: Find x."], [11, "Chapter 2: Vectors"]]);
    },
  );

  it("closes a completed inline answer before the next page", async () => {
    const result = await runPdfScenario({ pages: [
      { page: 1, text: "Exercise 1: Find x.\nAnswer: x = 5." },
      { page: 2, text: "Public explanation." },
    ] });
    expect(result.publishedChunks.map(chunk => chunk.text)).toEqual(["Exercise 1: Find x.", "Public explanation."]);
  });

  it.each([true, false])("withholds a continuation after conversion failure and replays safely after recovery (answer: %s)", async answer => {
    const segmentData = new Map<string, PdfSegment>();
    const pages = [
      ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." })),
      { page: 10, text: answer ? "Answer: x =" : "Public paragraph." },
      { page: 11, text: "5 units.", visualKinds: ["picture" as const] },
      { page: 12, text: "Chapter 2: Vectors" },
    ];
    const first = await runPdfScenario({ pages, segmentData, failedStarts: [1],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          expect(input.physicalPage).toBe(11);
          yield { text: "【原图忠实转写，尚需核对】\n5 units.\n【图表观察描述，非原文或解答】\nAnswer diagram.", imageObjectKey: "vision/page-11" };
        }
      },
      savedChunks: [{ page: 11, slideLabel: null, startMs: null, endMs: null, text: "Old continuation.", imageObjectKey: "old/page-11" }],
    });
    expect(first.requests).toEqual([{ start: 1 }, { start: 1 }, { start: 11 }]);
    expect(first.publishedChunks.map(chunk => chunk.text)).toEqual(["Chapter 2: Vectors"]);
    expect(first.preservePages).toEqual([]);
    expect(first.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });

    const recovered = await runPdfScenario({ pages, segmentData });
    expect(recovered.requests).toEqual(answer ? [{ start: 1 }, { start: 11, seed: "inline_sealed" }] : [{ start: 1 }]);
    expect(recovered.publishedChunks.some(chunk => chunk.text === "5 units.")).toBe(!answer);
    expect(recovered.publishedChunks.at(-1)?.text).toBe("Chapter 2: Vectors");
  });

  it("keeps a Vision-only public tail after a failed range and suppresses the image and commentary", async () => {
    const result = await runPdfScenario({
      pages: [
        ...Array.from({ length: 10 }, (_, index) => ({ page: index + 1, text: "Missing page." })),
        { page: 11, text: "", visualKinds: ["scan"] },
      ],
      failedStarts: [1],
      recognizePages: async function* () {
        yield {
          text: "【原图忠实转写，尚需核对】\n5 units.\n\nChapter 2: Vectors\nPublic chapter.\n【图表观察描述，非原文或解答】\nHidden diagram.\n【识别不确定，不能据此判定正确】\nHidden uncertainty.",
          imageObjectKey: "vision/page-11",
        };
      },
    });
    expect(result.publishedChunks).toMatchObject([{
      page: 11, imageObjectKey: null,
      text: "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nChapter 2: Vectors\nPublic chapter.",
    }]);
    expect(result.allowSealedEmpty).toBeUndefined();
  });

  it("permits an empty replacement when saved Vision was the only sealed content", async () => {
    const result = await runPdfScenario({
      pages: [{ page: 1, text: "", visualKinds: ["scan"] }],
      savedChunks: [{
        page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: "vision/old-page-1",
        text: "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nAnswer: x = 5.",
      }],
    });
    expect(result.publishedChunks).toEqual([]);
    expect(result.preservePages).toEqual([]);
    expect(result.allowSealedEmpty).toBe(true);
  });


  it("explicitly publishes an empty replacement for a wholly sealed PDF", async () => {
    const result = await runPdfScenario({
      pages: [{ page: 1, text: "", hadSealedContent: true, sectionSealedAtEnd: true }],
      savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: "1.1 x = 3", imageObjectKey: null }],
    });
    expect(result.publishedChunks).toEqual([]);
    expect(result.preservePages).toEqual([]);
    expect(result.allowSealedEmpty).toBe(true);
  });

  it.each(["", "   "])("does not waive readability for unsealed blank text %j", async text => {
    const result = await runPdfScenario({ pages: [{ page: 1, text, visualKinds: [] }] });
    expect(result.publishedChunks).toEqual([]);
    expect(result.allowSealedEmpty).toBeUndefined();
  });

  it("does not waive readability when Vision only reports uncertainty after a blank page", async () => {
    await expect(runPdfScenario({
      pages: [
        { page: 1, text: "", visualKinds: [] },
        { page: 2, text: "", visualKinds: ["scan"] },
      ],
      recognizePages: async function* () {
        yield { text: "【识别不确定，不能据此判定正确】\nNo legible text.", imageObjectKey: "vision/blank-scan" };
      },
    })).rejects.toThrow("第 2 页未能识别");
  });

  it.each(["live", "saved"] as const)("rejects a first-page scan containing only %s Vision uncertainty", async origin => {
    const text = "【识别不确定，不能据此判定正确】\nNo legible text.";
    const imageObjectKey = "vision/blank-scan";
    await expect(runPdfScenario({
      pages: [{ page: 1, text: "", visualKinds: ["scan"] }],
      ...(origin === "live" ? {
        recognizePages: async function* () { yield { text, imageObjectKey }; },
      } : {
        savedChunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey, text: "[视觉转写与描述]\n" + text }],
      }),
    })).rejects.toThrow("第 1 页未能识别");
  });

  it("keeps descriptions with uncertainty when the transcription is empty", async () => {
    const description = "【图表观察描述，非原文或解答】\nTwo circles overlap.";
    const uncertainty = "【识别不确定，不能据此判定正确】\nLabels are blurred.";
    const result = await runPdfScenario({
      pages: [{ page: 1, text: "", visualKinds: ["scan"] }],
      recognizePages: async function* () {
        yield {
          text: `【原图忠实转写，尚需核对】\n${description}\n${uncertainty}`,
          imageObjectKey: "vision/diagram",
        };
      },
    });
    expect(result.publishedChunks).toMatchObject([{
      text: `[视觉转写与描述]\n${description}\n\n${uncertainty}`, imageObjectKey: null,
    }]);
    expect(result.pdfWarning).toMatchObject({ code: "PARSE_PARTIAL" });
  });

  it("keeps the public tail after Docling closes the carried inline seal", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        ...Array.from({ length: 9 }, (_, index) => ({ page: index + 1, text: "Public page." })),
        { page: 10, text: "Exercise 1: Find x.", hadSealedContent: true, inlineSealedAtEnd: true },
        { page: 11, text: "A separate public paragraph.", hadSealedContent: true, inlineSealedAtEnd: false },
        { page: 12, text: "Public explanation." },
      ],
    });
    expect(publishedChunks.slice(-2).map(chunk => [chunk.page, chunk.text]))
      .toEqual([[11, "A separate public paragraph."], [12, "Public explanation."]]);
  });

  it.each([
    "Lecture 4: Homework",
    "Lecture 4: Assignments",
    "Lecture 4: Lab",
    "第 3 讲 作业题",
    "第 3 部分",
    "第 2 单元",
    "第 2 单元：阶段练习",
  ])("keeps %s sealed inside an answer section", async title => {
    const { publishedChunks } = await runPdfScenario({
      pages: [
        { page: 1, text: "Lecture 4: Solutions\n## " + title + "\n1. x = 5\n## 第 4 部分 向量空间\n定义：向量空间。" },
      ],
    });
    expect(publishedChunks.map(chunk => chunk.text)).toEqual(["## 第 4 部分 向量空间\n定义：向量空间。"]);
  });

  it.each(["native only", "native and Vision"])("rebuilds a reused %s chunk from the freshly filtered page", async scenario => {
    const vision = scenario === "native and Vision" ? "\n\n[视觉转写与描述]\nChapter 2: Rings\nPublic diagram." : "";
    const { publishedChunks } = await runPdfScenario({
      pages: [{ page: 1, text: "Current stem.", visualKinds: [], hadSealedContent: true }],
      savedChunks: [{
        page: 1, slideLabel: null, startMs: null, endMs: null,
        text: "Old stem.\n1.1 x = 3" + vision, imageObjectKey: "vision/old",
      }],
    });
    expect(publishedChunks[0]?.text).toBe("Current stem.");
    expect(publishedChunks[0]?.imageObjectKey).toBeNull();
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
              text: "【原图忠实转写，尚需核对】\nChapter 1: Geometry\n\nAnswer Key\n1. x = 2\n\n【图表观察描述，非原文或解答】\nAnswer table sketch.",
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
    expect(liveWrapped.publishedChunks[0]?.text).not.toContain("Figure 1 caption.");
    expect(liveWrapped.publishedChunks[0]?.text).not.toContain("Answer: x = 1.");
    expect(liveWrapped.publishedChunks[0]?.imageObjectKey).toBeNull();
    expect(liveWrapped.publishedChunks[1]?.text).toContain("Triangle ABC.");
    expect(liveWrapped.publishedChunks[1]?.text).toContain("Right angle at C.");
    expect(liveWrapped.publishedChunks[1]?.imageObjectKey).toBe("vision/clean-diagram");
    expect(liveWrapped.publishedChunks[2]?.text).toBe("[视觉转写与描述]\n【原图忠实转写，尚需核对】\nChapter 1: Geometry");
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
              text: "【原图忠实转写，尚需核对】\nChapter 1: Geometry\nAnswer Key\n1. x = 2\nEnd of Answers.\n\n【图表观察描述，非原文或解答】\nFull page shows x = 2.\n\n【识别不确定，不能据此判定正确】\nUncertain 2.",
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
    expect(live.publishedChunks[1]?.text).toBe("[视觉转写与描述]\n【原图忠实转写，尚需核对】\nChapter 1: Geometry");
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
        { page: 7, text: "Chapter 1: Geometry", visualKinds: ["scan"] },
      ],
      savedChunks: [
        {
          page: 7,
          slideLabel: null,
          startMs: null,
          endMs: null,
          text: "[视觉转写与描述]\n【原图忠实转写，尚需核对】\nChapter 1: Geometry\nAnswer Key\n1. x = 9\nEnd of Answers.\n\n【图表观察描述，非原文或解答】\nAnswer plot.",
          imageObjectKey: "vision/p7-stale",
        },
      ],
    });
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks.map(c => c.page)).toEqual([3, 6, 7]);
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks[0]?.text).toBe("第 3 讲 特征值\n定义：Ax = λx。");
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks[2]?.text).toBe("[视觉转写与描述]\n【原图忠实转写，尚需核对】\nChapter 1: Geometry");
    expect(lectureAnswerAndSavedSelfClosed.publishedChunks[2]?.imageObjectKey).toBeNull();
  });

  it("Round-7 [P1-5]: bounds same-page Vision on sectionSealedAtEnd, keeps seal across resume/fallback, and replays scanned raw Vision", async () => {
    const liveSamePageVision = await runPdfScenario({
      pages: [
        { page: 1, text: "Theorem 1: Norm equivalence.", visualKinds: ["picture"], sectionSealedAtEnd: true, hadSealedContent: true },
        { page: 2, text: "2. y = 4", visualKinds: [] },
        { page: 3, text: "Chapter 2: Rings\nDef.", visualKinds: [] },
      ],
      recognizePages: async function* () {
        yield {
          text: "【原图忠实转写，尚需核对】\nTheorem 1: Norm equivalence.\nUnit ball diagram.\nAnswer Key\n1. x = 2\n\n【图表观察描述，非原文或解答】\nShows answer plot.",
          imageObjectKey: "vision/p1-theorem",
        };
      },
    });
    expect(liveSamePageVision.pdfWarning).toBeUndefined();
    expect(liveSamePageVision.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(liveSamePageVision.publishedChunks[0]?.text).toBe("[原生提取]\nTheorem 1: Norm equivalence.\n\n[视觉转写与描述]\n【原图忠实转写，尚需核对】\nTheorem 1: Norm equivalence.");
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
    expect(resumeReusable.publishedChunks[0]?.text).toBe("Theorem 1.");
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
          text: "[视觉转写与描述]\nChapter 1: Geometry",
          imageObjectKey: null,
        },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          replayedPages.push(input.physicalPage);
          if (input.physicalPage === 1) {
            yield { text: "Chapter 1: Geometry\n\nAnswer Key\n1. x = 2", imageObjectKey: "vision/p1-cached" };
          }
        }
      },
    });
    expect(replayedPages).toEqual([1]);
    expect(scannedResumeWithNullKey.pdfWarning).toBeUndefined();
    expect(scannedResumeWithNullKey.publishedChunks.map(c => c.page)).toEqual([1, 3]);
    expect(scannedResumeWithNullKey.publishedChunks[0]?.text).toBe("[视觉转写与描述]\nChapter 1: Geometry");
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

  it("keeps the native stem when contaminated Vision opens at an unaligned heading", async () => {
    const { publishedChunks } = await runPdfScenario({
      pages: [{ page: 1, text: "Find x.", visualKinds: ["picture"], hadSealedContent: true }],
      recognizePages: async function* () {
        yield {
          text: "1. x = 5\nChapter 2: Rings\nPublic diagram caption.\nAnswer: y = 6\n\n2. z = 7",
          imageObjectKey: "vision/p1-contaminated",
        };
      },
    });
    expect(publishedChunks[0]?.text).toBe("Find x.");
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
    expect(mixedExitReenteringNewSeal.publishedChunks[0]?.text).not.toContain("Figure 2.1: Plot.");
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
    expect(workerStrippedInlineVisionDesc.publishedChunks[0]?.text).toBe("Problem 1.");
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
          text: "[视觉转写与描述]\nChapter 1: Geometry",
          imageObjectKey: null,
        },
      ],
      recognizePages: async function* (inputs) {
        for (const input of inputs) {
          if (input.physicalPage === 1) yield null;
          else if (input.physicalPage === 2) yield { text: "Chapter 1: Geometry\nAnswer Key\n1. x = 2", imageObjectKey: "vision/p2-cached" };
        }
      },
    });
    expect(partialDegradationBatch.publishedChunks.map(c => c.page)).toEqual([2, 4]);
    expect(partialDegradationBatch.publishedChunks[0]?.text).toBe("[视觉转写与描述]\nChapter 1: Geometry");
    expect(partialDegradationBatch.publishedChunks[0]?.imageObjectKey).toBeNull();
  });
});
