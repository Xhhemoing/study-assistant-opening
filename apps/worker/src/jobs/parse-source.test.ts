import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpeningModelRoutingError, type ModelGateway } from "@aistudy/ai";
import { sourceRecordSchema, type ApiFailure, type SourceChunk, type SourceRecord } from "@aistudy/contracts";
import { parseSourceVisualRecognitionOutput } from "@aistudy/ai";
import type { NewSourceChunk, OpeningJobRecord, OpeningPdfSegmentsRepository, OpeningSourceChunksRepository } from "@aistudy/database";
import type { ParserRunner } from "../parsers/types";
import { createSourceVisualRecognition } from "../runtime/source-visual-recognition";
import { createParseSourceHandler, type ParseSourceVisualPageInput } from "./parse-source";
import { fetchPresignedSourceObject } from "./source-object-download";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

type State = "not_started" | "queued" | "running" | "ready" | "failed" | "unsupported";
const sourceId = "00000000-0000-4000-8000-000000000001";
const scope = { workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003" };
const job = { id: "job", ...scope, key: "key", kind: "parse", payload: { sourceId }, result: null, state: "queued", privacyEpoch: 0 } as OpeningJobRecord;
const dirs: string[] = [];

afterEach(async () => { for (const dir of dirs.splice(0)) { expect(await readdir(dir)).toEqual([]); } });

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const defaultBytes = Buffer.from("pdf");

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { id: sourceId, workspaceId: scope.workspaceId, name: "source.pdf", mime: "application/pdf", bytes: 3, sha256: digest(defaultBytes), version: 7, uploadState: "uploaded", parseState: "not_started", error: null, createdAt: new Date().toISOString(), ...overrides };
}
type HandlerOverrides = Partial<Pick<Parameters<typeof createParseSourceHandler>[0], "storage" | "recognizePage" | "recognizePages">>;
async function deps(input: HandlerOverrides & { source?: SourceRecord; exitCode?: number; stdout?: string; pageCount?: number; bytes?: Uint8Array; runner?: ParserRunner; segments?: OpeningPdfSegmentsRepository; segmentPages?: number; published?: SourceChunk[]; assertCurrent?: Parameters<typeof createParseSourceHandler>[0]["assertCurrent"] } = {}) {
  const content = input.bytes ?? defaultBytes;
  const current = input.source ?? source({ bytes: content.byteLength, sha256: digest(content) });
  const states: State[] = [];
  const warnings: ApiFailure[] = [];
  let replaceInput: unknown;
  const replaceChunks: OpeningSourceChunksRepository["replaceChunks"] = async (_scope, input) => {
    replaceInput = input;
    states.push("ready");
    if (input.warning) warnings.push(input.warning);
  };
  let runs = 0;
  const argvs: string[][] = [];
  const dirPromise = mkdtemp(path.join(os.tmpdir(), "opening-parse-test-"));
  const all = dirPromise.then((tempDir) => ({
    tempDir,
    runs: () => runs,
    argvs: () => argvs,
    states, warnings,
    replaceInput: () => replaceInput,
    handler: createParseSourceHandler({
      sources: { get: async () => current, markParseState: async (_scope, _id, state, error) => { states.push(state); if (error) warnings.push(error); return current; } },
      chunks: {
        replaceChunks,
        replacePdfChunks: async (scope, { chunks, ...publication }) => {
          const rows: NewSourceChunk[] = [];
          for await (const chunk of chunks) rows.push(chunk);
          await replaceChunks(scope, { ...publication, chunks: rows });
        },
        listChunksAtVersion: async (_scope, _sourceId, _version, pages) =>
          (input.published ?? []).filter(chunk => pages && chunk.page != null && pages.includes(chunk.page)),
      },
      storage: input.storage ?? { finalKey: () => "final", presignGet: async () => `data:application/pdf;base64,${Buffer.from(content).toString("base64")}` },
      runner: async (...args: Parameters<ParserRunner>) => { argvs.push(args[0]); runs += 1; return input.runner ? input.runner(...args) : { exitCode: input.exitCode ?? 0, stdout: args[0].includes("--inspect-pdf") ? JSON.stringify({ pageCount: input.pageCount ?? 2 }) : input.stdout ?? JSON.stringify({ pages: [{ page: 1, text: "Alpha", imagePath: null }, { page: 2, text: "Beta", imagePath: null }] }) }; },
      tempDir, segments: input.segments, segmentPages: input.segmentPages,
      recognizePage: input.recognizePage, recognizePages: input.recognizePages, assertCurrent: input.assertCurrent,
    }),
  }));
  dirs.push(await dirPromise);
  return all;
}

describe("parse source handler", () => {
  it("reports low quality on a saved legacy page preserved beyond the UTF-16 staging limit", async () => {
    const legacyText = "😀".repeat(51_000) + "\uFFFD".repeat(2_000);
    const saved = { id: "00000000-0000-4000-8000-000000000004", sourceId, sourceVersion: 7, page: 1,
      slideLabel: null, startMs: null, endMs: null, text: legacyText, imageObjectKey: null };
    const d = await deps({ pageCount: 1, published: [saved],
      segments: { assertCurrent: async () => {}, read: async () => null, save: async () => {} },
      stdout: JSON.stringify({ pages: [{ page: 1, text: "Readable native text", imagePath: null }] }),
    });

    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 1 });
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, preservePages: [1], chunks: [],
      warning: { code: "PARSE_PARTIAL", message: "第 1 页识别质量低", retryable: false },
    });
  });

  it("retains published pages when their segment fails during a partial retry", async () => {
    const saved = { id: "saved-page", sourceId, sourceVersion: 7, page: 1, slideLabel: null,
      startMs: null, endMs: null, text: "Previously published page", imageObjectKey: "saved/page-1" };
    const d = await deps({
      segmentPages: 1, published: [saved],
      segments: { assertCurrent: async () => {}, read: async () => null, save: async () => {} },
      runner: async argv => {
        if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":2}' };
        if (argv[argv.indexOf("--page-start") + 1] === "1") return { exitCode: 4, stdout: "" };
        return { exitCode: 0, stdout: JSON.stringify({ pages: [{ page: 2, text: "Recovered page", imagePath: null }] }) };
      },
    });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 1 });
    expect(d.replaceInput()).toMatchObject({ preservePages: [1],
      chunks: [{ page: 2, text: "Recovered page" }],
      warning: { code: "PARSE_PARTIAL", retryable: true },
    });
  });

  it.each(["low quality", "discrete failures"])("keeps large PDF %s errors readable by the source contract", async scenario => {
    const d = await deps();
    let error: ApiFailure | null = null;
    const handler = createParseSourceHandler({
      sources: { get: async () => source(), markParseState: async () => { throw new Error("unexpected separate parse state write"); } },
      chunks: {
        replaceChunks: async () => { throw new Error("unexpected array publication"); },
        replacePdfChunks: async (_scope, input) => { error = input.warning ?? null; },
        listChunksAtVersion: async () => [],
      },
      storage: { finalKey: () => "final", presignGet: async () => "data:application/pdf;base64,cGRm" },
      tempDir: d.tempDir,
      runner: async argv => {
        if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: scenario === "low quality" ? 600 : 2000 }) };
        const start = Number(argv[argv.indexOf("--page-start") + 1]);
        const end = Number(argv[argv.indexOf("--page-end") + 1]);
        if (scenario === "discrete failures" && start % 20 === 1) return { exitCode: 4, stdout: "" };
        return { exitCode: 0, stdout: JSON.stringify({ pages: Array.from({ length: end - start + 1 }, (_, i) => ({ page: start + i, text: "x", imagePath: null })) }) };
      },
    });
    await handler(job, { sourceId });
    expect(error).toMatchObject({ code: "PARSE_PARTIAL", retryable: scenario === "discrete failures" });
    expect(sourceRecordSchema.safeParse(source({ parseState: "ready", error })).success).toBe(true);
    const message = (error as ApiFailure | null)?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(500);
    if (scenario === "low quality") expect(message).toBe("第 1–600 页识别质量低");
    else {
      expect(message).toContain("等共 1000 页未能识别，可以重新解析");
      expect(message).toContain("等共 1000 页识别质量低");
    }
  });
  it.each(["text/plain", "text/markdown", "text/html"])("cancels an oversized %s response before reading beyond the byte limit", async mime => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.error(new Error("body read beyond declared limit"));
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(65, 65, 65, 65)); },
      pull, cancel,
    }, { highWaterMark: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    try {
      const d = await deps({ source: source({ mime, bytes: 3 }) });
      await expect(d.handler(job, { sourceId })).rejects.toThrow("source download exceeds declared bytes");
      expect(cancel).toHaveBeenCalledOnce();
      expect(pull).not.toHaveBeenCalled();
      expect(d.replaceInput()).toBeUndefined();
      expect(d.runs()).toBe(0);
    } finally { fetchMock.mockRestore(); }
  });
  it.each(["text/plain", "text/markdown", "text/html"])("decodes split UTF-8 and strips a BOM from %s at the exact byte limit", async mime => {
    const bytes = Buffer.from("\uFEFF第一行\n第二行", "utf8");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        controller.enqueue(bytes.subarray(4, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    try {
      const d = await deps({ source: source({ mime, bytes: bytes.byteLength, sha256: digest(bytes).toUpperCase() }) });
      await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 1 });
      expect(d.replaceInput()).toMatchObject({ chunks: [{ page: 1, text: "第一行\n第二行", imageObjectKey: null }] });
      expect(d.states).toEqual(["ready"]);
      expect(d.runs()).toBe(0);
    } finally { fetchMock.mockRestore(); }
  });
  it.each(["text/plain", "text/markdown", "text/html", "application/pdf", "image/png", "application/vnd.openxmlformats-officedocument.presentationml.presentation"])(
    "rejects a clean early EOF on %s before parsing or replacing chunks", async mime => {
      const d = await deps({ source: source({ mime }), bytes: Buffer.from("pd") });
      await expect(d.handler(job, { sourceId })).rejects.toThrow(/download integrity.*expected 3 bytes.*received 2/i);
      expect(d.runs()).toBe(0);
      expect(d.replaceInput()).toBeUndefined();
      expect(d.states).toEqual([]);
    },
  );

  it.each(["text/markdown", "application/pdf"])(
    "rejects a same-length %s download with a mismatched SHA-256", async mime => {
      const d = await deps({ source: source({ mime }), bytes: Buffer.from("bad") });
      await expect(d.handler(job, { sourceId })).rejects.toThrow(/download integrity.*SHA-256/i);
      expect(d.runs()).toBe(0);
      expect(d.replaceInput()).toBeUndefined();
      expect(d.states).toEqual([]);
    },
  );

  it("recognizes only visual PDF pages and preserves native text, physical page and original file", async () => {
    const recognizePage = vi.fn(async (input: ParseSourceVisualPageInput) => {
      expect(await readFile(input.localFilePath, "utf8")).toBe("pdf");
      return {text:"转写：∫₀¹ x² dx；描述：图中箭头向右", imageObjectKey:"trusted/page-2"};
    });
    const d = await deps({recognizePage, stdout:JSON.stringify({pages:[
      {page:1,text:"native prose",imagePath:null,visualKinds:[]},
      {page:2,text:"original caption",imagePath:null,visualKinds:["formula","picture"]},
    ]})});
    await d.handler(job, {sourceId});
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(recognizePage).toHaveBeenCalledWith(expect.objectContaining({scope,job,sourceId,sourceVersion:7,physicalPage:2,nativeText:"original caption",mime:"application/pdf",visualKinds:["formula","picture"],signal:expect.any(AbortSignal)}));
    expect(d.replaceInput()).toMatchObject({chunks:[
      {page:1,text:"native prose",imageObjectKey:null},
      {page:2,text:"[原生提取]\noriginal caption\n\n[视觉转写与描述]\n转写：∫₀¹ x² dx；描述：图中箭头向右",imageObjectKey:"trusted/page-2"},
    ]});
  });
  it("publishes a native PDF page and a blank-page description without an unverified scan image", async () => {
    const description = "该页为空白页，没有可见文字或图形。";
    const recognizePage = vi.fn(async () => {
      const result = parseSourceVisualRecognitionOutput(JSON.stringify({
        transcription: "", description, uncertainties: [], contentKinds: [],
      }));
      return { text: "【图表观察描述，非原文或解答】\n" + result.description, imageObjectKey: "trusted/page-2" };
    });
    const d = await deps({ recognizePage, stdout: JSON.stringify({ pages: [
      { page: 1, text: "native prose", imagePath: null, visualKinds: [] },
      { page: 2, text: "", imagePath: null, visualKinds: ["scan"] },
    ] }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2, warnings: 1, degraded: true });
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(recognizePage).toHaveBeenCalledWith(expect.objectContaining({
      physicalPage: 2, nativeText: "", visualKinds: ["scan"],
    }));
    expect(d.replaceInput()).toMatchObject({ chunks: [
      { page: 1, text: "native prose", imageObjectKey: null },
      { page: 2, text: `[视觉转写与描述]\n【图表观察描述，非原文或解答】\n${description}`, imageObjectKey: null },
    ] });
    expect(d.states).toEqual(["ready"]);
  });
  it("publishes readable text with partial metadata when PDF vision is unconfigured", async () => {
    const d = await deps({ pageCount: 3, stdout: JSON.stringify({ pages: [
      { page: 1, text: "Native table caption", imagePath: null, visualKinds: ["table"] },
      { page: 2, text: "  ", imagePath: null },
      { page: 3, text: "Chapter 2: Readable native section", imagePath: null },
    ] }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 3, warnings: 2, degraded: true });
    expect(d.replaceInput()).toMatchObject({ chunks: [
      { page: 1, text: "Native table caption", imageObjectKey: null },
      { page: 3, text: "Chapter 2: Readable native section", imageObjectKey: null },
    ] });
    expect(d.warnings).toEqual([{ code: "PARSE_PARTIAL", message: "第 1–2 页未能识别，可以重新解析", retryable: true }]);
  });

  it("reports missing recognition for a scan with no readable pages without publishing it", async () => {
    const d = await deps({ pageCount: 1, stdout: JSON.stringify({ pages: [
      { page: 1, text: "", imagePath: null, visualKinds: ["scan"] },
    ] }) });
    await expect(d.handler(job, { sourceId })).rejects.toThrow("第 1 页未能识别，可以重新解析");
    expect(d.replaceInput()).toBeUndefined();
    expect(d.states).toEqual([]);
  });
  it("publishes an all-scan PDF when vision recovers its text", async () => {
    const d = await deps({ pageCount: 1, stdout: JSON.stringify({ pages: [
      { page: 1, text: "", imagePath: null, visualKinds: ["scan"] },
    ] }), recognizePage: async () => ({ text: "Recognized scan text", imageObjectKey: "trusted/page-1" }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 1 });
    expect(d.replaceInput()).toMatchObject({ chunks: [
      { page: 1, text: "[视觉转写与描述]\nRecognized scan text", imageObjectKey: "trusted/page-1" },
    ] });
    expect(d.warnings).toEqual([]);
  });

  it.each([
    { scenario: "three uncached scans", pageCount: 3, cachedPage: 0, publishedPage: 0, batches: [[1, 2, 3]] },
    { scenario: "multiple batches with cached and published pages", pageCount: 6, cachedPage: 2, publishedPage: 3, batches: [[1, 4], [5, 6]] },
  ])("reads the PDF once per batch for $scenario and preserves physical page order", async ({ pageCount, cachedPage, publishedPage, batches }) => {
    const renderPdf = vi.fn<NonNullable<Parameters<typeof createSourceVisualRecognition>[0]["renderPdf"]>>(
      async (_bytes, requests) => requests.map(request => ({ ...request, mediaType: "image/png",
        data: `data:image/png;base64,${Buffer.from(String(request.physicalPage)).toString("base64")}` })),
    );
    const modelSnapshot = { id: "vision", providerId: "test", modelName: "vision", inputCentsPerMillion: 10, outputCentsPerMillion: 50 };
    const call = vi.fn<ModelGateway["call"]>(async (_scope, _task, options) => {
      const page = options.input.imageParts[0]!.physicalPage;
      const output = { text: JSON.stringify({ transcription: `Chapter ${page}: Segment overview`, description: "",
        uncertainties: [], contentKinds: ["text"] }), requestId: null, citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1 };
      options.onModel?.({ modelSnapshot, provider: { complete: async () => output },
        inputCentsPerMillion: 10, outputCentsPerMillion: 50 }, { fallback: false });
      await options.beforeSend?.();
      await options.persistResult?.(output, { reservationId: `reservation-${page}`, settledCents: 1 });
      return output;
    });
    const save = vi.fn(async () => {});
    const visual = createSourceVisualRecognition({
      repository: { read: async (_scope, { physicalPage }) => physicalPage === cachedPage ? {
        result: { transcription: `Chapter ${cachedPage}: Segment overview`, description: "", uncertainties: [], contentKinds: ["text"] },
        modelSnapshot, operationId: "saved-operation", imageObjectKey: "final",
      } : null, save, assertCurrent: async () => {},
        ledger: async () => "unsent", releasedReservation: async () => null },
      gateway: { call }, budget: () => ({
        reserve: async () => { throw new Error("unexpected budget reservation"); },
        claimExecution: async () => false, release: async () => {}, settle: async () => {}, markUnknown: async () => {},
      }),
      storage: { finalKey: () => "final" }, renderPdf,
    });
    const pages = Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1, text: "", imagePath: null, visualKinds: ["scan" as const],
    }));
    const d = await deps({ ...visual, pageCount, stdout: JSON.stringify({ pages }),
      ...(publishedPage ? {
        segments: { assertCurrent: async () => {}, read: async () => ({ state: "ready", pages }), save: async () => {} },
        published: [{ id: "published", sourceId, sourceVersion: 7, page: publishedPage, slideLabel: null,
          startMs: null, endMs: null, text: `Chapter ${publishedPage}: Segment overview`, imageObjectKey: "final" }],
      } : {}),
    });
    vi.mocked(readFile).mockClear();

    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: pageCount });

    expect(readFile).toHaveBeenCalledTimes(batches.length);
    expect(renderPdf.mock.calls).toEqual(batches.map(batch => [defaultBytes, batch.map(physicalPage => ({ sourceId, physicalPage }))]));
    expect(call.mock.calls.map(([, , options]) => options.input.imageParts.map(image => image.physicalPage)))
      .toEqual(batches.flat().map(page => [page]));
    expect(save).toHaveBeenCalledTimes(batches.flat().length);
    expect(d.replaceInput()).toMatchObject({ chunks: pages.map(({ page }) => ({
      page, text: expect.stringContaining(`Chapter ${page}: Segment overview`), imageObjectKey: "final",
    })) });
  });

  it("retries vision for a cached fallback page and reuses a page with a saved transcription", async () => {
    const pages = [
      { page: 1, text: "Local OCR text", imagePath: null, visualKinds: ["scan" as const] },
      { page: 2, text: "", imagePath: null, visualKinds: ["scan" as const] },
    ];
    const recognizePage = vi.fn(async () => ({ text: "Recovered scan text", imageObjectKey: "trusted/page-1" }));
    const d = await deps({
      recognizePage,
      segments: { assertCurrent: async () => {}, read: async () => ({ state: "ready", pages }), save: async () => {} },
      published: [
        { id: "old-1", sourceId, sourceVersion: 7, page: 1, slideLabel: null, startMs: null, endMs: null, text: "Local OCR text", imageObjectKey: null },
        { id: "old-2", sourceId, sourceVersion: 7, page: 2, slideLabel: null, startMs: null, endMs: null, text: "Previously recognized scan", imageObjectKey: "trusted/page-2" },
      ],
    });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2 });
    expect(recognizePage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ physicalPage: 1 }));
    expect(d.replaceInput()).toMatchObject({ chunks: [
      { page: 1, text: expect.stringContaining("Recovered scan text"), imageObjectKey: "trusted/page-1" },
      { page: 2, text: "Previously recognized scan", imageObjectKey: "trusted/page-2" },
    ] });
    expect(d.warnings).toEqual([]);
  });

  it.each([
    { scenario: "oversized native text", nativeText: "n".repeat(100_001), capped: true },
    { scenario: "oversized vision text", nativeText: "", visionText: "v".repeat(100_001), capped: true },
    { scenario: "vision text at exactly the limit", nativeText: "",
      visionText: "v".repeat(100_000 - "[视觉转写与描述]\n".length), capped: false },
  ])("reuses the saved chunk and retains the correct warning for $scenario", async ({ nativeText, visionText, capped }) => {
    const pages = [
      { page: 1, text: nativeText, imagePath: null },
      { page: 2, text: "", imagePath: null },
    ];
    const published: SourceChunk[] = [];
    const current = source();
    let visionAvailableForPageTwo = false;
    const recognizePage = vi.fn(async ({ physicalPage }: ParseSourceVisualPageInput) => {
      if (physicalPage === 1 && visionText) return { text: visionText, imageObjectKey: "trusted/page-1" };
      if (physicalPage === 2 && visionAvailableForPageTwo) {
        return { text: "Recovered second page", imageObjectKey: "trusted/page-2" };
      }
      throw new OpeningModelRoutingError("vision route unavailable");
    });
    const d = await deps({
      source: current, published, recognizePage,
      segments: { assertCurrent: async () => {}, read: async () => ({ state: "ready", pages }), save: async () => {} },
    });
    const cappedMessage = "第 1 页达到文本长度上限，已保留原文或截短";

    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2, warnings: 1, degraded: true });
    const first = d.replaceInput() as { chunks: NewSourceChunk[]; warning: ApiFailure };
    expect(first.warning).toMatchObject({
      code: "PARSE_PARTIAL", retryable: true,
      message: "第 2 页未能识别，可以重新解析" + (capped ? `；${cappedMessage}` : ""),
    });
    expect(first.chunks).toHaveLength(1);
    const original = first.chunks[0]!;
    expect(original).toMatchObject({ page: 1, imageObjectKey: visionText ? "trusted/page-1" : null });
    expect(original.text).toHaveLength(100_000);
    current.error = visionText ? first.warning : null;
    published.push({ ...original, sourceId, sourceVersion: 7, id: "00000000-0000-4000-8000-000000000004" });

    recognizePage.mockClear();
    visionAvailableForPageTwo = true;
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2 });
    const retry = d.replaceInput() as { chunks: NewSourceChunk[]; warning?: ApiFailure };
    // PDF publication retains the original citation UUID when all chunk fields match.
    expect(retry.chunks).toEqual([
      original,
      { page: 2, slideLabel: null, startMs: null, endMs: null,
        imageObjectKey: "trusted/page-2", text: "[视觉转写与描述]\nRecovered second page" },
    ]);
    expect(recognizePage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ physicalPage: 2 }));
    if (capped) {
      expect(retry.warning).toMatchObject({ code: "PARSE_PARTIAL", message: cappedMessage, retryable: false });
    } else {
      expect(retry.warning).toBeUndefined();
    }
  });

  it.each([
    { pageCount: 2, cachedPages: [2], missingPages: "1", warnings: 1 },
    { pageCount: 6, cachedPages: [2, 3, 5], missingPages: "1、4、6", warnings: 3 },
  ])("publishes cached scans with section headings after routing fails on page 1 of a $pageCount-page PDF", async ({ pageCount, cachedPages, missingPages, warnings }) => {
    const call = vi.fn<ModelGateway["call"]>(async () => { throw new OpeningModelRoutingError("vision route unavailable"); });
    const renderPdf = vi.fn<NonNullable<Parameters<typeof createSourceVisualRecognition>[0]["renderPdf"]>>(
      async (_bytes, requests) => requests.map(request => ({ ...request, mediaType: "image/png", data: "data:image/png;base64,cGFnZQ==" })),
    );
    const visual = createSourceVisualRecognition({
      repository: {
        read: async (_scope, { physicalPage }) => cachedPages.includes(physicalPage) ? {
          result: { transcription: `Section ${physicalPage}: Cached readable section`, description: "", uncertainties: [], contentKinds: ["text"] },
          modelSnapshot: { id: "vision", providerId: "test", modelName: "vision", inputCentsPerMillion: 10, outputCentsPerMillion: 50 },
          operationId: `stored-page-${physicalPage}`, imageObjectKey: "final",
        } : null,
        save: async () => { throw new Error("unexpected recognition write"); },
        assertCurrent: async () => {}, ledger: async () => "unsent", releasedReservation: async () => null,
      },
      gateway: { call }, budget: () => ({
        reserve: async () => { throw new Error("unexpected budget reservation"); },
        claimExecution: async () => false, release: async () => {}, settle: async () => {}, markUnknown: async () => {},
      }),
      storage: { finalKey: () => "final" }, renderPdf,
    });
    const pages = Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1, text: "", imagePath: null, visualKinds: ["scan" as const],
    }));
    const d = await deps({ ...visual, pageCount, segmentPages: 4, segments: {
      assertCurrent: async () => {}, save: async () => {},
      read: async (_scope, { pageStart, pageEnd }) => ({ state: "ready", pages: pages.slice(pageStart - 1, pageEnd) }),
    } });

    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: pageCount, warnings, degraded: true });

    expect(d.states).toEqual(["ready"]);
    expect(d.replaceInput()).toMatchObject({ chunks: cachedPages.map(page => ({
      page, text: expect.stringContaining(`Section ${page}: Cached readable section`),
      imageObjectKey: cachedPages.includes(page - 1) ? "final" : null,
    })) });
    expect(d.warnings).toEqual([{ code: "PARSE_PARTIAL", message: `第 ${missingPages} 页未能识别，可以重新解析`, retryable: true }]);
    expect(call).toHaveBeenCalledExactlyOnceWith(scope, "materials.recognize-page", expect.objectContaining({
      input: expect.objectContaining({ imageParts: [expect.objectContaining({ physicalPage: 1 })] }),
    }));
    expect(renderPdf).toHaveBeenCalledExactlyOnceWith(defaultBytes, [{ sourceId, physicalPage: 1 }]);
  });

  it("preserves local PDF text and skips remaining recognition after a routing error", async () => {
    const recognizePage = vi.fn(async () => { throw new OpeningModelRoutingError("请先配置 gpt-6-luna"); });
    const d = await deps({ recognizePage, pageCount: 3, stdout: JSON.stringify({ pages: [
      { page: 1, text: "native prose", imagePath: null, visualKinds: [] },
      { page: 2, text: "local formula", imagePath: null, visualKinds: ["formula"] },
      { page: 3, text: "local OCR", imagePath: null, visualKinds: ["scan"] },
    ] }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 3, warnings: 2, degraded: true });
    expect(d.warnings).toEqual([{ code: "PARSE_PARTIAL", message: "第 2–3 页未能识别，可以重新解析", retryable: true }]);
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, preservePages: [], warning: d.warnings[0], chunks: [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "native prose", imageObjectKey: null },
      { page: 2, slideLabel: null, startMs: null, endMs: null, text: "local formula", imageObjectKey: null },
      { page: 3, slideLabel: null, startMs: null, endMs: null, text: "local OCR", imageObjectKey: null },
    ] });
    expect(d.states).toEqual(["ready"]);
    expect(recognizePage).toHaveBeenCalledOnce();
  });
  it("preserves an image-only chunk when visual model routing is unavailable", async () => {
    const recognizePage = vi.fn(async () => { throw new OpeningModelRoutingError("请先配置 gpt-6-luna"); });
    const d = await deps({ source: source({ mime: "image/png" }), recognizePage });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 1, imageOnly: true });
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, chunks: [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "", imageObjectKey: "final" },
    ] });
  });
  it("omits blank PDF chunks when visual routing is unavailable while keeping readable pages", async () => {
    const recognizePage = vi.fn(async () => { throw new OpeningModelRoutingError("请先配置 gpt-6-luna"); });
    const d = await deps({ recognizePage, stdout: JSON.stringify({ pages: [
      { page: 1, text: "native prose", imagePath: null },
      { page: 2, text: "", imagePath: null, visualKinds: ["scan"] },
    ] }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2, warnings: 1, degraded: true });
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, preservePages: [], warning: d.warnings[0], chunks: [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "native prose", imageObjectKey: null },
    ] });
    expect(d.warnings).toEqual([{ code: "PARSE_PARTIAL", message: "第 2 页未能识别，可以重新解析", retryable: true }]);
  });
  it("propagates provider errors without replacing chunks", async () => {
    const recognizePage = vi.fn(async () => { throw new Error("provider timeout"); });
    const d = await deps({ recognizePage, stdout: JSON.stringify({ pages: [
      { page: 1, text: "local formula", imagePath: null, visualKinds: ["formula"] },
      { page: 2, text: "native prose", imagePath: null, visualKinds: [] },
    ] }) });
    await expect(d.handler(job, { sourceId })).rejects.toThrow("provider timeout");
    expect(d.replaceInput()).toBeUndefined();
  });
  it("does not publish recognition returned after the source execution was revoked", async () => {
    let revoked = false;
    const d = await deps({source:source({mime:"image/png"}), assertCurrent:async () => {if(revoked) throw new Error("revoked");}, recognizePage:async () => {revoked=true;return {text:"recognized",imageObjectKey:"image"};}});
    await expect(d.handler(job, {sourceId})).rejects.toThrow("revoked");
    expect(d.replaceInput()).toBeUndefined();
  });
  it("passes an absolute temp path so the parser child (cwd=services/parser) finds the input", async () => {
    const d = await deps();
    await d.handler(job, job.payload);
    expect(d.argvs().length).toBe(2);
    const inputArg = d.argvs()[0][3]; // -m opening_parser --input <path>
    expect(path.isAbsolute(inputArg)).toBe(true);
    expect(await readdir(d.tempDir)).toEqual([]);
  });

  it("replaces PDF chunks, marks ready, and cleans the temporary file", async () => {
    const d = await deps();
    await d.handler(job, { sourceId });
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, preservePages: [], chunks: [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "Alpha", imageObjectKey: null },
      { page: 2, slideLabel: null, startMs: null, endMs: null, text: "Beta", imageObjectKey: null },
    ] });
    expect(d.states).toEqual(["ready"]);
    expect(await readdir(d.tempDir)).toEqual([]);
  });
  it("does not use the visual PDF/image execution callback for native PPTX parsing", async () => {
    const assertCurrent = vi.fn(async () => {throw new Error("visual-only callback");});
    const d = await deps({source:source({mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation"}), assertCurrent});
    await expect(d.handler(job, {sourceId})).resolves.toEqual({pages:2});
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(d.states).toEqual(["ready"]);
  });
  it("preserves native PPTX table and picture text without calling PDF/image recognition", async () => {
    const recognizePage = vi.fn(async () => { throw new Error("PDF/image recognition cannot render PPTX"); });
    const d = await deps({ source: source({ mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), recognizePage,
      stdout: JSON.stringify({ pages: [
        { page: 1, text: "Native table\n| x | y |", imagePath: null, visualKinds: ["table"] },
        { page: 2, text: "Native picture caption", imagePath: null, visualKinds: ["picture"] },
      ] }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2 });
    expect(recognizePage).not.toHaveBeenCalled();
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, chunks: [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "Native table\n| x | y |", imageObjectKey: null },
      { page: 2, slideLabel: null, startMs: null, endMs: null, text: "Native picture caption", imageObjectKey: null },
    ] });
    expect(d.states).toEqual(["ready"]);
  });
  it("marks audio unsupported without calling chunks", async () => {
    const d = await deps({ source: source({ mime: "audio/mpeg" }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ unsupported: true });
    expect(d.states).toEqual(["unsupported"]);
    expect(d.replaceInput()).toBeUndefined();
  });
  it("marks legacy ppt unsupported as stored-only without calling chunks", async () => {
    const d = await deps({ source: source({ mime: "application/vnd.ms-powerpoint", name: "deck.ppt" }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ unsupported: true, storedOnly: true });
    expect(d.states).toEqual(["unsupported"]);
    expect(d.replaceInput()).toBeUndefined();
    expect(d.runs()).toBe(0);
  });
  it("marks eml unsupported as stored-only without implying readable text", async () => {
    const d = await deps({ source: source({ mime: "message/rfc822", name: "lesson.eml" }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ unsupported: true, storedOnly: true });
    expect(d.states).toEqual(["unsupported"]);
    expect(d.replaceInput()).toBeUndefined();
    expect(d.runs()).toBe(0);
  });
  it("rejects conversion failure and leaves parse state untouched", async () => {
    const d = await deps({ exitCode: 4 });
    await expect(d.handler(job, { sourceId })).rejects.toThrow("document conversion failed");
    expect(d.states).toEqual([]);
  });
  it("rejects a chunk version conflict", async () => {
    const d = await deps();
    d.replaceInput();
    const original = d.handler;
    const conflict = createParseSourceHandler({
      sources: { get: async () => source(), markParseState: async () => source() },
      chunks: {
        replaceChunks: async () => { throw new Error("unexpected array publication"); },
        replacePdfChunks: async () => { throw new Error("CONFLICT: source version changed during parse"); },
        listChunksAtVersion: async () => [],
      },
      storage: { finalKey: () => "final", presignGet: async () => "data:application/pdf;base64,cGRm" },
      runner: async argv => ({ exitCode: 0, stdout: argv.includes("--inspect-pdf") ? '{"pageCount":1}' : '{"pages":[{"page":1,"text":"body","imagePath":null}]}' }), tempDir: d.tempDir,
    });
    void original;
    await expect(conflict(job, { sourceId })).rejects.toThrow("CONFLICT");
  });
  it("rejects a download that exceeds declared bytes before running the parser", async () => {
    const d = await deps({ source: source({ bytes: 3 }), bytes: Buffer.from("too-large") });
    await expect(d.handler(job, { sourceId })).rejects.toThrow("exceeds declared bytes");
    expect(d.runs()).toBe(0);
  });
  it("rejects parser bounds failures", async () => {
    const d = await deps({ exitCode: 5 });
    await expect(d.handler(job, { sourceId })).rejects.toThrow("parser bounds exceeded");
  });

  it("kills an in-flight segment after execution cancellation and never writes chunks/cache", async () => {
    const d = await deps();
    let cancelled = false;
    const save = vi.fn(async () => {});
    const replace = vi.fn(async () => {});
    const segments: OpeningPdfSegmentsRepository = {
      assertCurrent: async () => { if (cancelled) throw new Error("job cancelled"); }, read: async () => null, save,
    };
    const runner: ParserRunner = async (argv, signal) => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":1}' };
      cancelled = true;
      return new Promise((_resolve, reject) => {
        const hold = setTimeout(() => reject(new Error("cancellation was not propagated")), 1000);
        signal.addEventListener("abort", () => { clearTimeout(hold); reject(signal.reason); }, { once: true });
      });
    };
    const handler = createParseSourceHandler({
      sources: { get: async () => source(), markParseState: async () => source() },
      chunks: { replaceChunks: replace, replacePdfChunks: replace, listChunksAtVersion: async () => [] },
      storage: { finalKey: () => "final", presignGet: async () => "data:application/pdf;base64,cGRm" },
      runner, tempDir: d.tempDir, segments, executionPollMs: 5,
    });
    await expect(handler({ ...job, state: "running", claimToken: "claim" }, { sourceId })).rejects.toThrow("job cancelled");
    expect(save).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(await readdir(d.tempDir)).toEqual([]);
  });

  it("fails closed rather than running a claimed PDF without persistent cache wiring", async () => {
    const d = await deps();
    await expect(d.handler({ ...job, claimToken: "claim" }, { sourceId })).rejects.toThrow("repository is required");
    expect(d.runs()).toBe(0);
    expect(d.replaceInput()).toBeUndefined();
  });

  it("parses the canonical PDF without an object existence check", async () => {
    const canonicalKey = `opening/sources/${sourceId}/v7`;
    const objectExists = vi.fn(async () => { throw new Error("unexpected storage call"); });
    const presignGet = vi.fn(async () => `data:application/pdf;base64,${defaultBytes.toString("base64")}`);
    const d = await deps({ storage: { finalKey: () => canonicalKey, presignGet, objectExists } });

    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2 });
    expect(presignGet).toHaveBeenCalledExactlyOnceWith(canonicalKey, expect.any(Object));
    expect(objectExists).not.toHaveBeenCalled();
  });

  it.each(["HTTP 404", "transport error"])("preserves the canonical %s when both verified keys fail", async failure => {
    const id = "00000000-0000-4000-8000-0000000000ab";
    const canonical = `opening/sources/${id}/v7`;
    const fromPayload = canonical.replace("ab/", "Ab/");
    const fromJob = canonical.replace("ab/", "AB/");
    const missing = new Response("missing", { status: 404 });
    const canonicalError = new Error("canonical download failed");
    const failedFallback = new Response("unavailable", { status: 503 });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      if (failure === "HTTP 404") fetchMock.mockResolvedValueOnce(missing);
      else fetchMock.mockRejectedValueOnce(canonicalError);
      fetchMock.mockRejectedValueOnce(new Error("legacy download failed")).mockResolvedValueOnce(failedFallback);
      const result = fetchPresignedSourceObject({
        scope, source: { id, version: 7 }, job: { key: fromJob }, payload: { objectKey: fromPayload },
        storage: { finalKey: () => canonical, presignGet: async key => key }, sources: {},
      });
      if (failure === "HTTP 404") {
        await expect(result).resolves.toBe(missing);
        expect(missing.bodyUsed).toBe(true);
      } else {
        await expect(result).rejects.toBe(canonicalError);
      }
      expect(fetchMock.mock.calls).toEqual([[canonical], [fromPayload], [fromJob]]);
      expect(failedFallback.bodyUsed).toBe(true);
    } finally { fetchMock.mockRestore(); }
  });

  it("falls back to verified historical mixed-case object keys on parse and retry when canonical finalKey is absent", async () => {
    const hexSourceId = "00000000-0000-4000-8000-0000000000ab";
    const mixedId = hexSourceId.toUpperCase();
    const canonicalKey = `opening/sources/${hexSourceId}/v7`;
    const legacyKey = `opening/sources/${mixedId}/v7`;
    const textBytes = Buffer.from("Hello legacy markdown");
    const presignedKeys: string[] = [];
    const hexSource = source({ id: hexSourceId, mime: "text/plain", bytes: textBytes.byteLength, sha256: digest(textBytes) });
    const d = await deps({ source: hexSource });

    const resolveLegacyFinalKey = vi.fn(async () => legacyKey);
    const handler = createParseSourceHandler({
      sources: {
        get: async () => hexSource,
        markParseState: async () => hexSource,
        resolveLegacyFinalKey,
      },
      chunks: {
        replaceChunks: async () => {},
        replacePdfChunks: async () => {},
        listChunksAtVersion: async () => [],
      },
      storage: {
        finalKey: (id, version) => `opening/sources/${id}/v${version}`,
        objectExists: async (key) => key === legacyKey,
        presignGet: async (key) => {
          presignedKeys.push(key);
          if (key === legacyKey) return `data:text/plain;base64,${textBytes.toString("base64")}`;
          throw new Error("canonical object missing in storage");
        },
      },
      runner: async () => ({ exitCode: 0, stdout: "" }),
      tempDir: d.tempDir,
    });

    await expect(handler({ ...job, key: `parse:${hexSourceId}:v7:retry:abc` }, { sourceId: hexSourceId })).resolves.toEqual({ pages: 1 });
    expect(resolveLegacyFinalKey).toHaveBeenCalledWith(scope, hexSourceId, canonicalKey);
    expect(presignedKeys).toEqual([canonicalKey, legacyKey]);

    presignedKeys.length = 0;
    const rejectingHandler = createParseSourceHandler({
      sources: {
        get: async () => hexSource,
        markParseState: async () => hexSource,
        resolveLegacyFinalKey: vi.fn(async () => null),
      },
      chunks: {
        replaceChunks: async () => {},
        replacePdfChunks: async () => {},
        listChunksAtVersion: async () => [],
      },
      storage: {
        finalKey: (id, version) => `opening/sources/${id}/v${version}`,
        objectExists: async () => false,
        presignGet: async (key) => {
          presignedKeys.push(key);
          throw new Error("missing object in storage");
        },
      },
      runner: async () => ({ exitCode: 0, stdout: "" }),
      tempDir: d.tempDir,
    });
    await expect(rejectingHandler({ ...job, key: `parse:${hexSourceId}:v7:retry:def` }, {
      sourceId: hexSourceId,
      objectKey: `opening/sources/other-source/../${mixedId}/v7`,
    })).rejects.toThrow("missing object in storage");
    expect(presignedKeys).toEqual([canonicalKey]);
  });

  it("never substitutes a v1 mixed-case object when parsing or retrying v2", async () => {
    const hexSourceId = "00000000-0000-4000-8000-0000000000cd";
    const mixedId = hexSourceId.toUpperCase();
    const v1Bytes = Buffer.from("stale-v1");
    const v2Bytes = Buffer.from("fresh-v2");
    const v1MixedKey = `opening/sources/${mixedId}/v1`;
    const v2CanonicalKey = `opening/sources/${hexSourceId}/v2`;
    const v2MixedKey = `opening/sources/${mixedId}/v2`;
    const presignedKeys: string[] = [];
    const chunksPublished: unknown[] = [];
    const v2Source = source({
      id: hexSourceId,
      version: 2,
      mime: "text/plain",
      bytes: v2Bytes.byteLength,
      sha256: digest(v2Bytes),
    });
    const d = await deps({ source: v2Source });

    const handler = createParseSourceHandler({
      sources: {
        get: async () => v2Source,
        markParseState: async () => v2Source,
        resolveLegacyFinalKey: vi.fn(async (_s, _id, canonical) => (canonical === v2CanonicalKey ? v1MixedKey : null)),
      },
      chunks: {
        replaceChunks: async (_scope, input) => { chunksPublished.push(input); },
        replacePdfChunks: async () => {},
        listChunksAtVersion: async () => [],
      },
      storage: {
        finalKey: (id, version) => `opening/sources/${id}/v${version}`,
        objectExists: async (key) => key === v1MixedKey,
        presignGet: async (key) => {
          presignedKeys.push(key);
          if (key === v1MixedKey) return `data:text/plain;base64,${v1Bytes.toString("base64")}`;
          throw new Error("v2 object missing in storage");
        },
      },
      runner: async () => ({ exitCode: 0, stdout: "" }),
      tempDir: d.tempDir,
    });

    await expect(handler({ ...job, key: v1MixedKey }, {
      sourceId: hexSourceId,
      sourceVersion: 2,
      objectKey: v1MixedKey,
    })).rejects.toThrow("v2 object missing in storage");
    expect(presignedKeys).toEqual([v2CanonicalKey]);
    expect(chunksPublished).toEqual([]);

    presignedKeys.length = 0;
    const mixedV2Handler = createParseSourceHandler({
      sources: {
        get: async () => v2Source,
        markParseState: async () => v2Source,
        resolveLegacyFinalKey: vi.fn(async () => v2MixedKey),
      },
      chunks: {
        replaceChunks: async (_scope, input) => { chunksPublished.push(input); },
        replacePdfChunks: async () => {},
        listChunksAtVersion: async () => [],
      },
      storage: {
        finalKey: (id, version) => `opening/sources/${id}/v${version}`,
        objectExists: async (key) => key === v1MixedKey || key === v2MixedKey,
        presignGet: async (key) => {
          presignedKeys.push(key);
          if (key === v2MixedKey) return `data:text/plain;base64,${v2Bytes.toString("base64")}`;
          throw new Error(`unexpected key: ${key}`);
        },
      },
      runner: async () => ({ exitCode: 0, stdout: "" }),
      tempDir: d.tempDir,
    });

    await expect(mixedV2Handler({ ...job, key: v1MixedKey }, {
      sourceId: hexSourceId,
      sourceVersion: 2,
      objectKey: v1MixedKey,
    })).resolves.toEqual({ pages: 1 });
    expect(presignedKeys).toEqual([v2CanonicalKey, v2MixedKey]);
  });
});
