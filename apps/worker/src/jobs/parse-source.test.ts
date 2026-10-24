import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningJobRecord, OpeningPdfSegmentsRepository } from "@aistudy/database";
import type { ParserRunner } from "../parsers/types";
import { createParseSourceHandler } from "./parse-source";

type State = "not_started" | "queued" | "running" | "ready" | "failed" | "unsupported";
const sourceId = "00000000-0000-4000-8000-000000000001";
const scope = { workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003" };
const job = { id: "job", ...scope, key: "key", kind: "parse", payload: { sourceId }, result: null, state: "queued", privacyEpoch: 0 } as OpeningJobRecord;
const dirs: string[] = [];

afterEach(async () => { for (const dir of dirs.splice(0)) { expect(await readdir(dir)).toEqual([]); } });

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { id: sourceId, workspaceId: scope.workspaceId, name: "source.pdf", mime: "application/pdf", bytes: 3, sha256: "a".repeat(64), version: 7, uploadState: "uploaded", parseState: "not_started", error: null, createdAt: new Date().toISOString(), ...overrides };
}
async function deps(input: { source?: SourceRecord; exitCode?: number; stdout?: string; bytes?: Uint8Array } = {}) {
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
      runner: async (argv, _signal, stream) => {
        argvs.push(argv); runs += 1;
        const exitCode = input.exitCode ?? 0;
        if (argv.includes("--inspect-pdf")) return { exitCode, stdout: '{"pageCount":2}' };
        const stdout = input.stdout ?? JSON.stringify({ pages: [{ page: 1, text: "Alpha", imagePath: null }, { page: 2, text: "Beta", imagePath: null }] });
        if (stream) {
          if (exitCode === 0) await stream.onLine(JSON.stringify({ range: [1, 2], ...JSON.parse(stdout) }));
          return { exitCode, stdout: "" };
        }
        return { exitCode, stdout };
      },
      tempDir,
    }),
  }));
  dirs.push(await dirPromise);
  return all;
}

describe("parse source handler", () => {
  it("passes an absolute temp path so the parser child (cwd=services/parser) finds the input", async () => {
    const d = await deps();
    await d.handler(job, job.payload);
    expect(d.argvs().length).toBe(2);
    const inputArg = d.argvs()[0]![3]!; // -m opening_parser --input <path>; invocation count asserted above
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
      runner: async (argv, _signal, stream) => {
        if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":1}' };
        await stream!.onLine('{"range":[1,1],"pages":[{"page":1,"text":"body","imagePath":null}]}');
        return { exitCode: 0, stdout: "" };
      }, tempDir: d.tempDir,
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

  it("never publishes source chunks when a later range fails after an immediate cache save", async () => {
    const d = await deps();
    const save = vi.fn(async () => {}), replace = vi.fn(async () => {});
    const handler = createParseSourceHandler({
      sources: { get: async () => source(), markParseState: async () => source() },
      chunks: { replaceChunks: replace, listChunks: async () => [], listChunksAtVersion: async () => [], listForSources: async () => [] },
      storage: { finalKey: () => "final", presignGet: async () => "data:application/pdf;base64,cGRm" },
      runner: async (argv, _signal, stream) => {
        if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":2}' };
        await stream!.onLine('{"range":[1,1],"pages":[{"page":1,"text":"body","imagePath":null}]}');
        expect(save).toHaveBeenCalledOnce();
        expect(replace).not.toHaveBeenCalled();
        await stream!.onLine('{"range":[2,2],"error":"conversion_failed"}');
        return { exitCode: 4, stdout: "" };
      },
      tempDir: d.tempDir, segmentPages: 1,
      segments: { assertCurrent: async () => {}, read: async () => null, save },
    });
    await expect(handler({ ...job, state: "running", claimToken: "claim" }, { sourceId })).rejects.toThrow("document conversion failed");
    expect(save).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
  });

  it("fails closed rather than running a claimed PDF without persistent cache wiring", async () => {
    const d = await deps();
    await expect(d.handler({ ...job, claimToken: "claim" }, { sourceId })).rejects.toThrow("repository is required");
    expect(d.runs()).toBe(0);
    expect(d.replaceInput()).toBeUndefined();
  });
});
