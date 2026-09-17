import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
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
  const dirPromise = mkdtemp(path.join(os.tmpdir(), "opening-parse-test-"));
  const all = dirPromise.then((tempDir) => ({
    tempDir,
    runs: () => runs,
    states,
    replaceInput: () => replaceInput,
    handler: createParseSourceHandler({
      sources: { get: async () => current, markParseState: async (_scope, _id, state) => { states.push(state); return current; } },
      chunks: { replaceChunks: async (_scope, input) => { replaceInput = input; states.push("ready"); }, listChunks: async () => [] },
      storage: { finalKey: () => "final", presignGet: async () => `data:application/pdf;base64,${Buffer.from(input.bytes ?? Buffer.from("pdf")).toString("base64")}` },
      runner: async () => { runs += 1; return { exitCode: input.exitCode ?? 0, stdout: input.stdout ?? JSON.stringify({ pages: [{ page: 1, text: "Alpha", imagePath: null }, { page: 2, text: "Beta", imagePath: null }] }) }; },
      tempDir,
    }),
  }));
  dirs.push(await dirPromise);
  return all;
}

describe("parse source handler", () => {
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
    await d.handler(job, { sourceId });
    expect(d.states).toEqual(["unsupported"]);
    expect(d.replaceInput()).toBeUndefined();
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
      chunks: { replaceChunks: async () => { throw new Error("CONFLICT: source version changed during parse"); }, listChunks: async () => [] },
      storage: { finalKey: () => "final", presignGet: async () => "data:application/pdf;base64,cGRm" },
      runner: async () => ({ exitCode: 0, stdout: '{"pages":[]}' }), tempDir: d.tempDir,
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
});
