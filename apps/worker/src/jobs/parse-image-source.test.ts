import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
import { createParseSourceHandler } from "./parse-source";

type State = "not_started" | "queued" | "running" | "ready" | "failed" | "unsupported";
const sourceId = "00000000-0000-4000-8000-0000000000a1";
const scope = { workspaceId: "00000000-0000-4000-8000-0000000000a2", ownerUserId: "00000000-0000-4000-8000-0000000000a3" };
const job = { id: "job", ...scope, key: "key", kind: "parse", payload: { sourceId }, result: null, state: "queued", privacyEpoch: 0 } as OpeningJobRecord;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    expect(await readdir(dir)).toEqual([]);
  }
});

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: sourceId,
    workspaceId: scope.workspaceId,
    name: "photo.png",
    mime: "image/png",
    bytes: 8,
    sha256: "b".repeat(64),
    version: 3,
    uploadState: "uploaded",
    parseState: "not_started",
    error: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function makeHandler(current: SourceRecord) {
  const states: State[] = [];
  let replaceInput: unknown;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-image-"));
  dirs.push(tempDir);
  const handler = createParseSourceHandler({
    sources: {
      get: async () => current,
      markParseState: async (_scope, _id, state) => {
        states.push(state);
        return current;
      },
    },
    chunks: {
      replaceChunks: async (_scope, input) => {
        replaceInput = input;
        states.push("ready");
      },
      listChunks: async () => [],
    },
    storage: {
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
      presignGet: async () => "data:image/png;base64,iVBORw0KGgo=",
    },
    runner: async () => {
      throw new Error("image parse must not call document parser");
    },
    tempDir,
  });
  return { handler, states, replaceInput: () => replaceInput, tempDir };
}

describe("parse image sources", () => {
  it("parses PNG into one page-1 chunk with image key and ready state", async () => {
    const d = await makeHandler(source());
    const result = await d.handler(job, { sourceId });
    expect(result).toEqual({ pages: 1, imageOnly: true });
    expect(d.replaceInput()).toEqual({
      sourceId,
      sourceVersion: 3,
      chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: "", imageObjectKey: `opening/sources/${sourceId}/v3` }],
    });
    expect(d.states).toEqual(["ready"]);
    expect(d.states.includes("unsupported")).toBe(false);
  });

  it("parses JPEG and WebP the same way", async () => {
    for (const mime of ["image/jpeg", "image/webp"] as const) {
      const d = await makeHandler(source({ mime, name: `photo.${mime.split("/")[1]}` }));
      await d.handler(job, { sourceId });
      expect(d.states).toEqual(["ready"]);
      expect((d.replaceInput() as { chunks: { imageObjectKey: string }[] }).chunks[0]!.imageObjectKey).toContain(`/v3`);
    }
  });
});
