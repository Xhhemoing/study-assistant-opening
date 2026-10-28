import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { parseSourceVisualRecognitionOutput } from "@aistudy/ai";
import type { OpeningJobRecord, OpeningPdfSegmentsRepository } from "@aistudy/database";
import type { ParserRunner } from "../parsers/types";
import { createParseSourceHandler, type ParseSourceVisualPageInput } from "./parse-source";

type State = "not_started" | "queued" | "running" | "ready" | "failed" | "unsupported";
const sourceId = "00000000-0000-4000-8000-000000000001";
const scope = { workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003" };
const job = { id: "job", ...scope, key: "key", kind: "parse", payload: { sourceId }, result: null, state: "queued", privacyEpoch: 0 } as OpeningJobRecord;
const dirs: string[] = [];

afterEach(async () => { for (const dir of dirs.splice(0)) { expect(await readdir(dir)).toEqual([]); } });

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { id: sourceId, workspaceId: scope.workspaceId, name: "source.pdf", mime: "application/pdf", bytes: 3, sha256: "a".repeat(64), version: 7, uploadState: "uploaded", parseState: "not_started", error: null, createdAt: new Date().toISOString(), ...overrides };
}
async function deps(input: { source?: SourceRecord; exitCode?: number; stdout?: string; bytes?: Uint8Array; recognizePage?: Parameters<typeof createParseSourceHandler>[0]["recognizePage"]; assertCurrent?: Parameters<typeof createParseSourceHandler>[0]["assertCurrent"] } = {}) {
  const current = input.source ?? source({ bytes: input.bytes?.byteLength ?? 3 });
  const states: State[] = [];
  let replaceInput: unknown;
  let runs = 0;
  const argvs: string[][] = [];
  const dirPromise = mkdtemp(path.join(os.tmpdir(), "opening-parse-test-"));
  const all = dirPromise.then((tempDir) => ({
    tempDir,
    runs: () => runs,
    argvs: () => argvs,
    states,
    replaceInput: () => replaceInput,
    handler: createParseSourceHandler({
      sources: { get: async () => current, markParseState: async (_scope, _id, state) => { states.push(state); return current; } },
      chunks: { replaceChunks: async (_scope, input) => { replaceInput = input; states.push("ready"); }, listChunks: async () => [], listChunksAtVersion: async () => [], listForSources: async () => [] },
      storage: { finalKey: () => "final", presignGet: async () => `data:application/pdf;base64,${Buffer.from(input.bytes ?? Buffer.from("pdf")).toString("base64")}` },
      runner: async (...args: Parameters<ParserRunner>) => { argvs.push(args[0]); runs += 1; return { exitCode: input.exitCode ?? 0, stdout: args[0].includes("--inspect-pdf") ? '{"pageCount":2}' : input.stdout ?? JSON.stringify({ pages: [{ page: 1, text: "Alpha", imagePath: null }, { page: 2, text: "Beta", imagePath: null }] }) }; },
      tempDir, recognizePage: input.recognizePage, assertCurrent: input.assertCurrent,
    }),
  }));
  dirs.push(await dirPromise);
  return all;
}

describe("parse source handler", () => {
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
      const d = await deps({ source: source({ mime, bytes: bytes.byteLength }) });
      await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 1 });
      expect(d.replaceInput()).toMatchObject({ chunks: [{ page: 1, text: "第一行\n第二行", imageObjectKey: null }] });
      expect(d.states).toEqual(["ready"]);
      expect(d.runs()).toBe(0);
    } finally { fetchMock.mockRestore(); }
  });
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
  it("publishes a native PDF page and an honestly described blank page together", async () => {
    const description = "该页为空白页，没有可见文字或图形。";
    const recognizePage = vi.fn(async () => {
      const result = parseSourceVisualRecognitionOutput(JSON.stringify({
        transcription: "", description, uncertainties: [], contentKinds: [],
      }));
      return { text: result.description, imageObjectKey: "trusted/page-2" };
    });
    const d = await deps({ recognizePage, stdout: JSON.stringify({ pages: [
      { page: 1, text: "native prose", imagePath: null, visualKinds: [] },
      { page: 2, text: "", imagePath: null, visualKinds: ["scan"] },
    ] }) });
    await expect(d.handler(job, { sourceId })).resolves.toEqual({ pages: 2 });
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(recognizePage).toHaveBeenCalledWith(expect.objectContaining({
      physicalPage: 2, nativeText: "", visualKinds: ["scan"],
    }));
    expect(d.replaceInput()).toMatchObject({ chunks: [
      { page: 1, text: "native prose", imageObjectKey: null },
      { page: 2, text: `[视觉转写与描述]\n${description}`, imageObjectKey: "trusted/page-2" },
    ] });
    expect(d.states).toEqual(["ready"]);
  });
  it("fails closed on a visual or blank PDF page without recognition", async () => {
    for (const page of [{page:1,text:"caption",imagePath:null,visualKinds:["table"]}, {page:1,text:"",imagePath:null}]) {
      const d = await deps({stdout:JSON.stringify({pages:[page,{page:2,text:"native",imagePath:null}]})});
      await expect(d.handler(job, {sourceId})).rejects.toThrow("visual recognition");
      expect(d.replaceInput()).toBeUndefined();
    }
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
    expect(d.replaceInput()).toEqual({ sourceId, sourceVersion: 7, chunks: [
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
      chunks: { replaceChunks: async () => { throw new Error("CONFLICT: source version changed during parse"); }, listChunks: async () => [], listChunksAtVersion: async () => [], listForSources: async () => [] },
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
      chunks: { replaceChunks: replace, listChunks: async () => [], listChunksAtVersion: async () => [], listForSources: async () => [] },
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
});
