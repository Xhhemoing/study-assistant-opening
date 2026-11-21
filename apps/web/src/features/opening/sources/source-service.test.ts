import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { createOpeningSourceService } from "./source-service";
import { createOpeningSourceActionsRepository, OpeningSourceError, type OpeningStorage } from "@aistudy/database";
import type { Principal } from "../../../lib/authorization";

const principal: Principal = {
  userId: "00000000-0000-4000-8000-0000000000aa",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  sessionId: "sess",
};

const otherPrincipal: Principal = {
  userId: "00000000-0000-4000-8000-0000000000bb",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "sess",
};

const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x78)]);
const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");
const jpegBytes = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(204, 0x11),
]);
const jpegSha = createHash("sha256").update(jpegBytes).digest("hex");

type FakeRow = Record<string, unknown>;

/** In-memory opening_sources + insert counters backing a tagged-template fake. */
function makeFakeSql() {
  const sources = new Map<string, FakeRow>();
  let jobInserts = 0;
  let outboxInserts = 0;
  const jobEpochs: number[] = [];
  let historyRevision = 0;
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    // Nested postgres.js fragments evaluate as standalone tagged calls before the outer query composes.
    if (query === "FALSE" || query.startsWith("p.privacy_source_ids") || query.startsWith("p.root_observation_id")
      || query.startsWith("baseline.source_ids &&") || query.startsWith("r.learning_protocol->>'baselineRootId'=")) return query;
    if (query.startsWith("INSERT INTO opening_sources")) {
      const [id, workspaceId, name, mime, bytes, sha256] = values as [
        string,
        string,
        string,
        string,
        number,
        string,
      ];
      const row: FakeRow = {
        id,
        workspace_id: workspaceId,
        name,
        mime,
        bytes,
        sha256,
        version: 0,
        upload_state: "pending",
        parse_state: "not_started",
        error: null,
        created_at: new Date(),
      };
      sources.set(id, row);
      return [row];
    }
    if (query.startsWith("SELECT * FROM opening_sources")) {
      const [id, workspaceId] = values as [string, string];
      const row = sources.get(id);
      return row && row.workspace_id === workspaceId ? [row] : [];
    }
    if (query.startsWith("WITH quota_objects AS")) {
      return [{ bytes: [...sources.values()].reduce((sum, row) => sum + Number(row.bytes), 0), objects: sources.size }];
    }
    if (query === "SELECT owner_user_id FROM workspaces WHERE id=?"
      || query === "SELECT owner_user_id FROM workspaces WHERE id=? FOR SHARE") {
      const owner = [principal, otherPrincipal].find(candidate => candidate.workspaceId === values[0]);
      return owner ? [{ owner_user_id: owner.userId }] : [];
    }
    if (query.startsWith("SELECT id FROM workspaces")) return [{ id: values[0] }];
    if (query.startsWith("SELECT id, privacy_epoch FROM workspaces")) return [{ id: values[0], privacy_epoch: 7 }];
    if (query.startsWith("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 7 }];
    if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) return [];
    if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return [{ revision: historyRevision }];
    if (query.startsWith("UPDATE opening_workspace_history_revisions")) {
      historyRevision += 1;
      return [{ revision: historyRevision }];
    }
    if (query.startsWith("DELETE FROM opening_learning_eligibility")) return [];
    if (query.startsWith("INSERT INTO opening_source_versions")) return [];
    if (query.startsWith("UPDATE opening_sources SET upload_url_expires_at")) {
      const row = sources.get(values[1] as string);
      if (row) row.upload_url_expires_at = values[0];
      return [];
    }
    if (query.startsWith("UPDATE opening_sources SET parse_state")) {
      const id = values.find((value): value is string => typeof value === "string" && sources.has(value));
      const row = id ? sources.get(id) : undefined;
      if (row) {
        row.parse_state = "queued";
        row.error = null;
        return [row];
      }
      return [];
    }
    if (query.startsWith("UPDATE opening_sources")) {
      const [id, workspaceId] = values as [string, string];
      const row = sources.get(id);
      if (row && row.workspace_id === workspaceId && row.upload_state === "pending") {
        row.upload_state = "uploaded";
        if (query.includes("parse_state")) {
          row.parse_state = "queued";
          row.error = null;
        }
        return [row];
      }
      return [];
    }
    if (query.startsWith("INSERT INTO opening_jobs")) {
      jobInserts += 1;
      jobEpochs.push(Number(values.at(-1)));
      return [{ id: values[0], state: "queued" }];
    }
    if (query.startsWith("INSERT INTO opening_outbox")) {
      outboxInserts += 1;
      return [];
    }
    throw new Error(`unexpected sql: ${query}`);
  }) as unknown as Sql & {
    counts(): { jobInserts: number; outboxInserts: number };
    jobEpochs(): number[];
    sources: Map<string, FakeRow>;
  };
  tag.json = ((value: unknown) => value) as never;
  tag.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(tag as unknown as Sql)) as never;
  tag.counts = () => ({ jobInserts, outboxInserts });
  tag.jobEpochs = () => [...jobEpochs];
  tag.sources = sources;
  return tag;
}

function makeFakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let etagCounter = 0;
  const putObject = async (key: string, bytes: Uint8Array, _input?: { mime?: string }) => {
    etagCounter += 1;
    objects.set(key, { bytes, etag: `etag-${etagCounter}` });
  };
  const storage: OpeningStorage = {
    stagingKey: (id) => `staging/${id}`,
    finalKey: (id, version) => `final/${id}/v${version}`,
    presignPut: async (key) => `fake://put/${key}`,
    presignGet: async (key, input) => `fake://get/${key}?disposition=${encodeURIComponent(input.responseContentDisposition)}&cache=${encodeURIComponent(input.responseCacheControl)}`,
    headObject: async (key) => {
      const object = objects.get(key);
      return object
        ? { exists: true, bytes: object.bytes.length, etag: object.etag, mime: "spoofed/lie" }
        : { exists: false, bytes: 0, etag: "", mime: "" };
    },
    streamDigest: async (key, limit) => {
      const bytes = objects.get(key)?.bytes ?? new Uint8Array();
      const allowed = bytes.subarray(0, limit);
      return {
        bytes: bytes.length,
        sha256: createHash("sha256").update(allowed).digest("hex"),
        firstBytes: allowed.slice(0, 16),
      };
    },
    copyStagingToFinal: async (from, to, input) => {
      const object = objects.get(from);
      if (!object) throw new Error("missing staging object");
      if (object.etag !== input.expectedEtag) throw new Error("etag precondition failed");
      objects.set(to, object);
    },
    copyObject: async (from, to) => {
      const object = objects.get(from);
      if (!object) throw new Error("missing object");
      objects.set(to, object);
    },
    putObject,
    putObjectStream: async (key, body) => {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        await putObject(key, Buffer.concat(chunks));
      } finally { reader.releaseLock(); }
    },
    deleteObject: async (key) => {
      objects.delete(key);
    },
    getObjectStream: async (key) => {
      const object = objects.get(key);
      if (!object) throw new Error("missing object");
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.bytes);
            controller.close();
          },
        }),
        contentType: "application/octet-stream",
        contentLength: object.bytes.byteLength,
      };
    },
    objectExists: async (key) => objects.has(key),
  };
  const put = (key: string, bytes: Uint8Array) => {
    etagCounter += 1;
    objects.set(key, { bytes, etag: `etag-${etagCounter}` });
  };
  return { storage, put, has: (key: string) => objects.has(key), objects };
}

function setup() {
  const sql = makeFakeSql();
  const { storage, put, has } = makeFakeStorage();
  const svc = createOpeningSourceService(sql, storage);
  return { svc, sql, put, has };
}

describe("opening signed upload service", () => {
  it("records a 900s staging lease from the issue time", async () => {
    const sql = makeFakeSql(), { storage } = makeFakeStorage();
    const svc = createOpeningSourceService(sql, storage, { now: () => new Date("2026-09-30T01:12:00Z") });
    const ticket = await svc.beginUpload(principal, { name: "signed.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    expect(ticket.expiresAt).toBe("2026-09-30T01:27:00.000Z");
    expect(sql.sources.get(ticket.source.id)?.upload_url_expires_at).toEqual(new Date(ticket.expiresAt));
  });
  it("returns a same-origin staging PUT URL instead of a MinIO presign", async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3000";
    try {
      const { svc } = setup();
      const ticket = await svc.beginUpload(principal, {
        name: "a.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.length,
        sha256: pdfSha,
      });
      expect(ticket.uploadUrl).toBe(
        `http://127.0.0.1:3000/api/opening/sources/${ticket.source.id}/staging`,
      );
      expect(ticket.uploadUrl).toContain(`/api/opening/sources/${ticket.source.id}/staging`);
      expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prev;
    }
  });

  it("fails closed when PUBLIC_BASE_URL is missing in production", async () => {
    const prevUrl = process.env.PUBLIC_BASE_URL;
    const prevEnv = process.env.NODE_ENV;
    delete process.env.PUBLIC_BASE_URL;
    process.env.NODE_ENV = "production";
    try {
      const { svc } = setup();
      await expect(
        svc.beginUpload(principal, {
          name: "a.pdf",
          mime: "application/pdf",
          bytes: pdfBytes.length,
          sha256: pdfSha,
        }),
      ).rejects.toThrow(/PUBLIC_BASE_URL is required in production/);
    } finally {
      if (prevUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prevUrl;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });

  it("uses configured PUBLIC_BASE_URL in production", async () => {
    const prevUrl = process.env.PUBLIC_BASE_URL;
    const prevEnv = process.env.NODE_ENV;
    process.env.PUBLIC_BASE_URL = "https://study.example.com";
    process.env.NODE_ENV = "production";
    try {
      const { svc } = setup();
      const ticket = await svc.beginUpload(principal, {
        name: "a.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.length,
        sha256: pdfSha,
      });
      expect(ticket.uploadUrl).toBe(
        `https://study.example.com/api/opening/sources/${ticket.source.id}/staging`,
      );
      expect(ticket.uploadUrl).not.toContain("127.0.0.1");
    } finally {
      if (prevUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prevUrl;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });

  it("falls back to loopback staging host when PUBLIC_BASE_URL is unset outside production", async () => {
    const prevUrl = process.env.PUBLIC_BASE_URL;
    const prevEnv = process.env.NODE_ENV;
    delete process.env.PUBLIC_BASE_URL;
    process.env.NODE_ENV = "test";
    try {
      const { svc } = setup();
      const ticket = await svc.beginUpload(principal, {
        name: "a.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.length,
        sha256: pdfSha,
      });
      expect(ticket.uploadUrl).toBe(
        `http://127.0.0.1:3000/api/opening/sources/${ticket.source.id}/staging`,
      );
    } finally {
      if (prevUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prevUrl;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });

  it("completes a matching upload with one job and one outbox insert", async () => {
    const { svc, sql, put, has } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    const record = await svc.completeUpload(principal, ticket.source.id);
    expect(record.uploadState).toBe("uploaded");
    expect(sql.counts()).toEqual({ jobInserts: 1, outboxInserts: 1 });
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
    expect(has(`final/${ticket.source.id}/v0`)).toBe(true);
    expect(sql.jobEpochs()).toEqual([7]);
  });

  // C03 manual fallback honesty: ordinary inbox/source upload must stay `manual`
  // and must never write connection import receipts (fake SQL throws on unexpected
  // opening_import_receipts inserts, so a successful completeUpload is the proof).
  it("does not create opening_import_receipt rows on ordinary upload completion", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "export-screenshot.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await expect(svc.completeUpload(principal, ticket.source.id)).resolves.toMatchObject({
      uploadState: "uploaded",
    });
    expect(sql.counts()).toEqual({ jobInserts: 1, outboxInserts: 1 });
  });

  it("requeues a failed uploaded source without creating a second source", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "failed.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const stored = sql.sources.get(ticket.source.id);
    if (!stored) throw new Error("missing source");
    stored.parse_state = "failed";

    const retried = await svc.retryParse(principal, ticket.source.id);

    expect(retried.id).toBe(ticket.source.id);
    expect(retried.parseState).toBe("queued");
    expect(sql.counts()).toEqual({ jobInserts: 2, outboxInserts: 2 });
    expect(sql.jobEpochs()).toEqual([7, 7]);
  });

  it("does not retry a source excluded by privacy deletion", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "excluded.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const stored = sql.sources.get(ticket.source.id);
    if (!stored) throw new Error("missing source");
    stored.parse_state = "failed";
    stored.error = { code: "PRIVACY_EXCLUDED", message: "excluded", retryable: false };
    await expect(svc.retryParse(principal, ticket.source.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replays an already-uploaded completion without new inserts", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const replay = await svc.completeUpload(principal, ticket.source.id);
    expect(replay.uploadState).toBe("uploaded");
    expect(sql.counts()).toEqual({ jobInserts: 1, outboxInserts: 1 });
  });

  it("rejects completion when the staging object is missing", async () => {
    const { svc, sql } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /upload not found/i,
    );
    expect(sql.counts()).toEqual({ jobInserts: 0, outboxInserts: 0 });
  });

  it("rejects a MIME spoof before any database write", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: jpegBytes.length,
      sha256: jpegSha,
    });
    put(`staging/${ticket.source.id}`, jpegBytes);
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /magic bytes/i,
    );
    expect(sql.counts()).toEqual({ jobInserts: 0, outboxInserts: 0 });
  });

  it("rejects a bytes mismatch before any database write", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes.subarray(0, 10));
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /bytes/i,
    );
    expect(sql.counts()).toEqual({ jobInserts: 0, outboxInserts: 0 });
  });

  it("rejects a sha mismatch before any database write", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: "a".repeat(64),
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /sha256/i,
    );
    expect(sql.counts()).toEqual({ jobInserts: 0, outboxInserts: 0 });
  });

  it("refuses downloads for pending sources", async () => {
    const { svc } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(svc.getDownloadUrl(principal, ticket.source.id)).rejects.toThrow(
      OpeningSourceError,
    );
  });

  it("signs downloads as private attachments", async () => {
    const { svc, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const download = await svc.getDownloadUrl(principal, ticket.source.id);
    expect(download.url).toContain(`final/${ticket.source.id}/v0`);
    expect(download.version).toBe(0);
    expect(download.versionMismatch).toBe(false);
    expect(download.url).toContain("attachment");
    expect(download.url).toContain("private%2C%20no-store");
  });

  it("signs a cited older version without silently opening the current object", async () => {
    const { svc, sql, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const stored = sql.sources.get(ticket.source.id);
    if (!stored) throw new Error("missing source");
    stored.version = 1;
    put(`final/${ticket.source.id}/v0`, pdfBytes);
    const download = await svc.getDownloadUrl(principal, ticket.source.id, 0);
    expect(download.url).toContain(`final/${ticket.source.id}/v0`);
    expect(download.version).toBe(0);
    expect(download.currentVersion).toBe(1);
    expect(download.versionMismatch).toBe(true);
    await expect(svc.getDownloadUrl(principal, ticket.source.id, 2)).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("keeps another workspace's source invisible", async () => {
    const { svc, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await expect(
      svc.completeUpload(otherPrincipal, ticket.source.id),
    ).rejects.toThrow(OpeningSourceError);
  });
  it("putStaging stores bytes at the staging key", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(
      svc.putStaging(principal, ticket.source.id, {
        contentType: "application/pdf",
        bytes: pdfBytes,
      }),
    ).resolves.toEqual({ ok: true });
    expect(has(`staging/${ticket.source.id}`)).toBe(true);
  });

  it("streams a verified upload and preserves the existing completion checks", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, { name: "a.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pdfBytes.subarray(0, 4)); controller.enqueue(pdfBytes.subarray(4)); controller.close(); } });
    await svc.putStagingStream(principal, ticket.source.id, { contentType: "application/pdf; charset=binary", body });
    expect(has(`staging/${ticket.source.id}`)).toBe(true);
    expect((await svc.completeUpload(principal, ticket.source.id)).uploadState).toBe("uploaded");
  });

  it("rejects stream hash mismatch before storing an object", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, { name: "a.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: "a".repeat(64) });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(pdfBytes); controller.close(); } });
    await expect(svc.putStagingStream(principal, ticket.source.id, { contentType: "application/pdf", body })).rejects.toThrow(/sha256/);
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
  });

  it("keeps another workspace's streaming target invisible", async () => {
    const { svc } = setup();
    const ticket = await svc.beginUpload(principal, { name: "a.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(svc.putStagingStream(otherPrincipal, ticket.source.id, { contentType: "application/pdf", body })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(cancelled).toBe(true);
  });

  it("cancels the body when the pending upload lease has expired", async () => {
    const sql = makeFakeSql();
    const { storage, has } = makeFakeStorage();
    let currentTime = new Date();
    const svc = createOpeningSourceService(sql, storage, { now: () => currentTime });
    const ticket = await svc.beginUpload(principal, { name: "a.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    currentTime = new Date(currentTime.getTime() + 16 * 60_000);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(svc.putStagingStream(principal, ticket.source.id, { contentType: "application/pdf", body })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(cancelled).toBe(true);
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
  });

  it("aborts a cancelled request without storing an object", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, { name: "a.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    const abort = new AbortController();
    abort.abort();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(svc.putStagingStream(principal, ticket.source.id, { contentType: "application/pdf", body, signal: abort.signal })).rejects.toThrow(/取消/);
    expect(cancelled).toBe(true);
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
  });

  it("cancels an in-progress body when its signed lease runs out", async () => {
    const sql = makeFakeSql();
    const { storage, has } = makeFakeStorage();
    const currentTime = new Date("2030-01-01T00:00:00Z");
    const svc = createOpeningSourceService(sql, storage, { now: () => currentTime });
    const ticket = await svc.beginUpload(principal, { name: "a.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    sql.sources.get(ticket.source.id)!.upload_url_expires_at = new Date(currentTime.getTime() + 20);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(svc.putStagingStream(principal, ticket.source.id, { contentType: "application/pdf", body })).rejects.toThrow(/过期/);
    expect(cancelled).toBe(true);
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
  });

  it("putStaging accepts Content-Type with parameters when the base mime matches", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf; charset=binary",
      bytes: pdfBytes,
    });
    expect(has(`staging/${ticket.source.id}`)).toBe(true);
  });

  it("putStaging rejects a mime mismatch", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(
      svc.putStaging(principal, ticket.source.id, {
        contentType: "image/jpeg",
        bytes: pdfBytes,
      }),
    ).rejects.toThrow(/mime/i);
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
  });

  it("putStaging rejects a bytes mismatch", async () => {
    const { svc, has } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(
      svc.putStaging(principal, ticket.source.id, {
        contentType: "application/pdf",
        bytes: pdfBytes.subarray(0, 10),
      }),
    ).rejects.toThrow(/bytes/i);
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
  });

  it("putStaging rejects an already-uploaded source", async () => {
    const { svc, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    await expect(
      svc.putStaging(principal, ticket.source.id, {
        contentType: "application/pdf",
        bytes: pdfBytes,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("putStaging keeps another workspace invisible", async () => {
    const { svc } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(
      svc.putStaging(otherPrincipal, ticket.source.id, {
        contentType: "application/pdf",
        bytes: pdfBytes,
      }),
    ).rejects.toThrow(OpeningSourceError);
  });

  it("streams download bytes without embedding a MinIO endpoint", async () => {
    const { svc, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const download = await svc.getDownloadStream(principal, ticket.source.id);
    expect(download.contentType).toBe("application/pdf");
    expect(download.contentDisposition).toContain("attachment");
    expect(download.contentDisposition).toContain("a.pdf");
    expect(download.version).toBe(0);
    expect(download.versionMismatch).toBe(false);
    const reader = download.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(bytes.equals(pdfBytes)).toBe(true);
    const asText = [
      download.contentType,
      download.contentDisposition,
      String(download.contentLength),
    ].join(" ");
    expect(asText).not.toContain("127.0.0.1:9000");
    expect(asText).not.toMatch(/https?:\/\/[^/]*:?9000/);
  });

  it("streams previewable MIME with inline disposition when requested", async () => {
    const { svc, put } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const download = await svc.getDownloadStream(principal, ticket.source.id, undefined, {
      disposition: "inline",
    });
    expect(download.contentDisposition).toContain("inline");
    expect(download.contentDisposition).toContain("a.pdf");
  });

  it.each(["高数讲义.pdf", "O'Brien (1).pdf", "\ud800.pdf"])("downloads %s with a valid ASCII header and encoded Unicode filename", async (name) => {
    const { svc, put } = setup();
    const ticket = await svc.beginUpload(principal, { name, mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    put(`staging/${ticket.source.id}`, pdfBytes);
    await svc.completeUpload(principal, ticket.source.id);
    const download = await svc.getDownloadStream(principal, ticket.source.id);
    const headers = new Headers({ "Content-Disposition": download.contentDisposition });
    expect(headers.get("Content-Disposition")).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    const encoded = download.contentDisposition.split("filename*=UTF-8''")[1]!;
    expect(decodeURIComponent(encoded)).toBe(new TextDecoder().decode(new TextEncoder().encode(name)));
    expect(encoded).not.toMatch(/[!'()*]/);
  });

  it("reissueUploadTicket refreshes the same-origin staging lease for pending only", async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "http://app.example:3000";
    try {
      const sql = makeFakeSql();
      const { storage, put } = makeFakeStorage();
      const svc = createOpeningSourceService(sql, storage, {
        now: () => new Date("2026-10-10T12:00:00Z"),
      });
      const ticket = await svc.beginUpload(principal, {
        name: "a.pdf",
        mime: "application/pdf",
        bytes: pdfBytes.length,
        sha256: pdfSha,
      });
      const reissued = await svc.reissueUploadTicket(principal, ticket.source.id);
      expect(reissued.source.id).toBe(ticket.source.id);
      expect(reissued.uploadUrl).toBe(
        `http://app.example:3000/api/opening/sources/${ticket.source.id}/staging`,
      );
      expect(reissued.expiresAt).toBe("2026-10-10T12:15:00.000Z");
      expect(sql.sources.get(ticket.source.id)?.upload_url_expires_at).toEqual(
        new Date(reissued.expiresAt),
      );

      put(`staging/${ticket.source.id}`, pdfBytes);
      await svc.completeUpload(principal, ticket.source.id);
      await expect(svc.reissueUploadTicket(principal, ticket.source.id)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prev;
    }
  });

  it("reissueUploadTicket keeps another workspace invisible", async () => {
    const { svc } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await expect(svc.reissueUploadTicket(otherPrincipal, ticket.source.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("putStaging then completeUpload succeeds end-to-end", async () => {
    const { svc, sql, has } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf",
      bytes: pdfBytes,
    });
    const record = await svc.completeUpload(principal, ticket.source.id);
    expect(record.uploadState).toBe("uploaded");
    expect(sql.counts()).toEqual({ jobInserts: 1, outboxInserts: 1 });
    expect(has(`staging/${ticket.source.id}`)).toBe(false);
    expect(has(`final/${ticket.source.id}/v0`)).toBe(true);
  });

  it("canonicalizes mixed-case source IDs on new writes while falling back cleanly for legacy mixed-case keys", async () => {
    const { svc, sql, has, put } = setup();
    const first = await svc.beginUpload(principal, {
      name: "canon.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    const upper = first.source.id.toUpperCase();
    await svc.putStaging(principal, upper, {
      contentType: "application/pdf",
      bytes: pdfBytes,
    });
    expect(has(`staging/${first.source.id}`)).toBe(true);
    expect(has(`staging/${upper}`)).toBe(false);
    await svc.completeUpload(principal, upper);
    expect(has(`staging/${first.source.id}`)).toBe(false);
    expect(has(`final/${first.source.id}/v0`)).toBe(true);
    expect(has(`final/${upper}/v0`)).toBe(false);
    const dl = await svc.getDownloadUrl(principal, upper);
    expect(dl.url).toContain(`final/${first.source.id}/v0`);
    const dlStream = await svc.getDownloadStream(principal, upper);
    await dlStream.body.cancel();

    const streamed = await svc.beginUpload(principal, {
      name: "stream.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    const streamedUpper = streamed.source.id.toUpperCase();
    await svc.putStagingStream(principal, streamedUpper, {
      contentType: "application/pdf",
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(pdfBytes); c.close(); } }),
    });
    expect(has(`staging/${streamed.source.id}`)).toBe(true);
    expect(has(`staging/${streamedUpper}`)).toBe(false);

    const legacy = await svc.beginUpload(principal, {
      name: "legacy.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    const legacyUpper = legacy.source.id.toUpperCase();
    put(`staging/${legacyUpper}`, pdfBytes);
    await svc.completeUpload(principal, legacyUpper);
    expect(has(`staging/${legacyUpper}`)).toBe(false);
    expect(has(`final/${legacy.source.id}/v0`)).toBe(true);
    expect(has(`final/${legacyUpper}/v0`)).toBe(false);

    const legacyDownload = await svc.beginUpload(principal, {
      name: "legacy-dl.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    const legacyDlUpper = legacyDownload.source.id.toUpperCase();
    sql.sources.get(legacyDownload.source.id)!.upload_state = "uploaded";
    put(`final/${legacyDlUpper}/v0`, pdfBytes);
    const legacyDlResult = await svc.getDownloadUrl(principal, legacyDlUpper);
    expect(legacyDlResult.url).toContain(`final/${legacyDlUpper}/v0`);
    const legacyDlStream = await svc.getDownloadStream(principal, legacyDlUpper);
    await legacyDlStream.body.cancel();
  });

  it("resolves historical mixed-case opening_jobs.key on normal lowercase downloads and retryParse, and keeps notBefore on lowercase retry_cleanup", async () => {
    const { sql, storage, objects } = (() => {
      const fake = makeFakeSql();
      const s3 = makeFakeStorage();
      const baseStorage: OpeningStorage = {
        ...s3.storage,
        stagingKey: (id) => `opening/staging/${id}`,
        finalKey: (id, version) => `opening/sources/${id}/v${version}`,
      };
      return { sql: fake, storage: baseStorage, objects: s3.objects };
    })();
    const jobs: { key: string; kind: string; payload: { sourceId: string; objectKey?: string } }[] = [];
    let pendingKeys = ["opening/staging/00000000-0000-4000-8000-0000000000ef"];
    let cleanedCalls = 0;
    const futureNotBefore = new Date("2030-01-01T01:00:00.000Z");
    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("INSERT INTO opening_jobs")) {
        const key = String(values[3]);
        const kind = String(values[4]);
        const payload = values[5] as { sourceId: string; objectKey?: string };
        jobs.push({ key, kind, payload });
      }
      if (query.startsWith("SELECT j.key FROM opening_jobs j")) {
        const canonicalLower = String(values[3]).toLowerCase();
        const canonicalExact = String(values[4]);
        const matched = jobs.find(j => j.key.toLowerCase() === canonicalLower && j.key !== canonicalExact);
        return matched ? [{ key: matched.key }] : [];
      }
      if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
        return pendingKeys.length
          ? [{
              id: "00000000-0000-4000-8000-000000000088",
              workspace_id: principal.workspaceId,
              source_id: "00000000-0000-4000-8000-0000000000ef",
              asset_deleted_at: new Date("2030-01-01T00:00:00.000Z"),
              pending_object_keys: pendingKeys,
              cleanup_not_before: futureNotBefore,
            }]
          : [];
      }
      if (query.startsWith("SELECT pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove")) {
        cleanedCalls += 1;
        pendingKeys = pendingKeys.filter(k => k !== values[0]);
        return [];
      }
      return (sql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof sql, {
      json: sql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    const fixedNow = new Date("2030-01-01T00:10:00.000Z");
    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage, { now: () => fixedNow });
    const ticket = await svc.beginUpload(principal, {
      name: "legacy-inbox.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    const canonicalId = ticket.source.id;
    const upperId = canonicalId.toUpperCase();
    const legacyFinalKey = storage.finalKey(upperId, 0);
    objects.set(legacyFinalKey, { bytes: pdfBytes, etag: "etag-legacy" });
    sql.sources.get(canonicalId)!.upload_state = "uploaded";
    sql.sources.get(canonicalId)!.parse_state = "failed";
    jobs.push({ key: legacyFinalKey, kind: "parse", payload: { sourceId: upperId } });

    const dl = await svc.getDownloadUrl(principal, canonicalId);
    expect(dl.url).toContain(legacyFinalKey);
    const stream = await svc.getDownloadStream(principal, canonicalId);
    await stream.body.cancel();

    const retried = await svc.retryParse(principal, canonicalId);
    expect(retried.parseState).toBe("queued");
    expect(jobs.at(-1)?.payload.objectKey).toBe(legacyFinalKey);

    const upperStagingKey = "opening/staging/" + "00000000-0000-4000-8000-0000000000ef".toUpperCase();
    pendingKeys = [upperStagingKey];
    objects.set(upperStagingKey, { bytes: pdfBytes, etag: "etag-staging" });
    const retryResult = await svc.actOnSource(principal, "00000000-0000-4000-8000-0000000000ef", {
      action: "retry_cleanup",
    });
    expect(objects.has(upperStagingKey)).toBe(false);
    expect(cleanedCalls).toBe(0);
    expect(retryResult).toMatchObject({
      deleted: true,
      cleanupPending: 1,
      retryAfter: futureNotBefore.toISOString(),
    });
  });

  it("isolates v2 retryParse and downloads from historical v1 mixed-case keys", async () => {
    const sql = makeFakeSql();
    const s3 = makeFakeStorage();
    const storage: OpeningStorage = {
      ...s3.storage,
      stagingKey: (id) => `opening/staging/${id}`,
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
    };
    const jobs: { key: string; kind: string; payload: { sourceId: string; sourceVersion?: number; objectKey?: string } }[] = [];
    const lookupQueries: { canonicalLower: string; canonicalExact: string }[] = [];
    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("INSERT INTO opening_jobs")) {
        jobs.push({
          key: String(values[3]),
          kind: String(values[4]),
          payload: values[5] as { sourceId: string; sourceVersion?: number; objectKey?: string },
        });
      }
      if (query.startsWith("SELECT j.key FROM opening_jobs j")) {
        const canonicalLower = String(values[3]).toLowerCase();
        const canonicalExact = String(values[4]);
        lookupQueries.push({ canonicalLower, canonicalExact });
        const matched = jobs.find(j => j.key.toLowerCase() === canonicalLower && j.key !== canonicalExact);
        return matched ? [{ key: matched.key }] : [];
      }
      return (sql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof sql, {
      json: sql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage);
    const ticket = await svc.beginUpload(principal, {
      name: "multi-version.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    const canonicalId = ticket.source.id;
    const upperId = canonicalId.toUpperCase();
    const v1MixedKey = storage.finalKey(upperId, 1);
    const v2CanonicalKey = storage.finalKey(canonicalId, 2);
    const v2MixedKey = storage.finalKey(upperId, 2);
    s3.objects.set(v1MixedKey, { bytes: pdfBytes, etag: "etag-v1" });
    jobs.push({ key: v1MixedKey, kind: "parse", payload: { sourceId: upperId, sourceVersion: 1 } });

    const row = sql.sources.get(canonicalId)!;
    row.upload_state = "uploaded";
    row.parse_state = "failed";
    row.version = 2;

    // Missing v2 must never fall back to v1 mixed-case key on download or retryParse.
    await expect(svc.getDownloadUrl(principal, canonicalId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(lookupQueries.at(-1)).toEqual({
      canonicalLower: v2CanonicalKey.toLowerCase(),
      canonicalExact: v2CanonicalKey,
    });

    const retriedWithoutV2 = await svc.retryParse(principal, canonicalId);
    expect(retriedWithoutV2.parseState).toBe("queued");
    expect(jobs.at(-1)?.payload).toEqual({ sourceId: canonicalId, sourceVersion: 2 });
    expect(lookupQueries.at(-1)).toEqual({
      canonicalLower: v2CanonicalKey.toLowerCase(),
      canonicalExact: v2CanonicalKey,
    });

    // When a mixed-case v2 key exists alongside v1, resolution picks strictly v2.
    s3.objects.set(v2MixedKey, { bytes: pdfBytes, etag: "etag-v2" });
    jobs.push({ key: v2MixedKey, kind: "parse", payload: { sourceId: upperId, sourceVersion: 2 } });
    row.parse_state = "failed";
    const dlV2 = await svc.getDownloadUrl(principal, canonicalId);
    expect(dlV2.url).toContain(v2MixedKey);
    const retriedWithV2 = await svc.retryParse(principal, canonicalId);
    expect(retriedWithV2.parseState).toBe("queued");
    expect(jobs.at(-1)?.payload).toEqual({
      sourceId: canonicalId,
      sourceVersion: 2,
      objectKey: v2MixedKey,
    });
  });

  it("cleans legacy pending_upload mixed-case and uppercase staging objects with zero jobs or chunks", async () => {
    const baseSql = makeFakeSql();
    const s3 = makeFakeStorage();
    const storage: OpeningStorage = {
      ...s3.storage,
      stagingKey: (id) => `opening/staging/${id}`,
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
      listMatchingStagingKeys: async (canonicalId) =>
        [...s3.objects.keys()].filter(key => key.toLowerCase() === `opening/staging/${canonicalId.toLowerCase()}`),
    };
    let canonicalId = "";
    let pendingKeys: string[] = [];
    let exclusionCreated = false;
    let notBefore: Date | null = null;
    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("SELECT version, upload_url_expires_at FROM opening_sources")) {
        const row = baseSql.sources.get(String(values[0]));
        return row ? [{ version: 0, upload_url_expires_at: row.upload_url_expires_at }] : [];
      }
      if (query.startsWith("SELECT * FROM opening_privacy_exclusions")) {
        return exclusionCreated ? [{ id: "00000000-0000-4000-8000-000000000099", source_id: canonicalId, pending_object_keys: pendingKeys, cleanup_not_before: notBefore }] : [];
      }
      if (query.startsWith("SELECT m.id") || query.startsWith("UPDATE opening_course_knowledge")
        || query.startsWith("UPDATE workspaces SET privacy_epoch")
        || query.startsWith("SELECT version FROM opening_source_versions") || query.startsWith("SELECT image_object_key")
        || query.startsWith("DELETE FROM course_asset_memberships") || query.startsWith("UPDATE opening_source_versions")) {
        return [];
      }
      if (query.startsWith("DELETE FROM opening_sources")) {
        baseSql.sources.delete(String(values[1]));
        return [];
      }
      if (query.startsWith("INSERT INTO opening_privacy_exclusions")) {
        exclusionCreated = true;
        return [];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET asset_deleted_at")) {
        pendingKeys = values[1] as string[];
        notBefore = values[2] as Date;
        return [];
      }
      if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
        return pendingKeys.length ? [{ id: "00000000-0000-4000-8000-000000000099", source_id: canonicalId, pending_object_keys: pendingKeys, cleanup_not_before: notBefore }] : [];
      }
      if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) return [];
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove")) {
        pendingKeys = pendingKeys.filter(k => k !== values[0]);
        return [];
      }
      return (baseSql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof baseSql, {
      json: baseSql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage);
    const ticket = await svc.beginUpload(principal, {
      name: "legacy-pending.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    canonicalId = ticket.source.id;
    const upperKey = storage.stagingKey(canonicalId.toUpperCase());
    const mixedKey = `opening/staging/${canonicalId.slice(0, 6).toUpperCase()}${canonicalId.slice(6)}`;
    s3.objects.set(upperKey, { bytes: pdfBytes, etag: "etag-upper" });
    s3.objects.set(mixedKey, { bytes: pdfBytes, etag: "etag-mixed" });

    const res = await svc.actOnSource(principal, canonicalId, {
      action: "delete",
      expectedVersion: 0,
      expectedMembershipIds: [],
    });
    expect(res).toMatchObject({ sourceId: canonicalId, deleted: true, cleanupPending: 1 });
    expect(s3.objects.has(upperKey)).toBe(false);
    expect(s3.objects.has(mixedKey)).toBe(false);
    expect(pendingKeys).toEqual([storage.stagingKey(canonicalId)]);
  });

  it("defers S3 deletion and release on connector reservations until cleanup_not_before expires", async () => {
    const sql = makeFakeSql();
    const s3 = makeFakeStorage();
    const storage: OpeningStorage = {
      ...s3.storage,
      stagingKey: (id) => `opening/staging/${id}`,
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
    };
    const connSourceId = "00000000-0000-4000-8000-0000000000c1";
    const reservationId = "00000000-0000-8000-8000-0000000000c1";
    const connKey = storage.finalKey(connSourceId, 0);
    s3.objects.set(connKey, { bytes: pdfBytes, etag: "etag-conn" });
    let reservationActive = true;
    const notBefore = new Date("2030-01-01T00:02:00.000Z");

    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
        return reservationActive ? [{
          id: reservationId,
          workspace_id: principal.workspaceId,
          source_id: connSourceId,
          asset_deleted_at: new Date("2030-01-01T00:00:00.000Z"),
          pending_object_keys: [connKey],
          cleanup_not_before: notBefore,
        }] : [];
      }
      if (query.startsWith("SELECT pg_try_advisory_xact_lock")) return [{ acquired: true }];
      if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) {
        return reservationActive ? [{ id: reservationId, cleanup_not_before: notBefore }] : [];
      }
      if (query.startsWith("DELETE FROM opening_source_versions")) return [{ source_id: connSourceId }];
      if (query.startsWith("DELETE FROM opening_privacy_exclusions")) {
        reservationActive = false;
        return [];
      }
      return (sql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof sql, {
      json: sql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    let clock = new Date("2030-01-01T00:00:30.000Z");
    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage, { now: () => clock });
    const actions = createOpeningSourceActionsRepository(wrappedSql as unknown as Sql);

    const deferred = await svc.actOnSource(principal, connSourceId, { action: "retry_cleanup" });
    expect(deferred).toEqual({
      sourceId: connSourceId,
      aiExcluded: true,
      deleted: true,
      cleanupPending: 1,
      retryAfter: notBefore.toISOString(),
    });
    expect(s3.objects.has(connKey)).toBe(true);
    expect(await actions.cleaned(
      { workspaceId: principal.workspaceId, ownerUserId: principal.userId },
      connSourceId,
      connKey,
      clock,
    )).toBe(false);
    expect(reservationActive).toBe(true);

    clock = new Date("2030-01-01T00:02:01.000Z");
    const released = await svc.actOnSource(principal, connSourceId, { action: "retry_cleanup" });
    expect(released).toEqual({
      sourceId: connSourceId,
      aiExcluded: true,
      deleted: true,
      cleanupPending: 0,
      retryAfter: null,
    });
    expect(s3.objects.has(connKey)).toBe(false);
    expect(reservationActive).toBe(false);
  });

  it("keeps staging cleanup pending when listMatchingStagingKeys fails or is incomplete until retry succeeds", async () => {
    const baseSql = makeFakeSql();
    const s3 = makeFakeStorage();
    let listShouldFail = true;
    const storage: OpeningStorage = {
      ...s3.storage,
      stagingKey: (id) => `opening/staging/${id}`,
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
      listMatchingStagingKeys: async (canonicalId) => {
        if (listShouldFail) throw new Error("incomplete storage listing");
        return [...s3.objects.keys()].filter(key => key.toLowerCase() === `opening/staging/${canonicalId.toLowerCase()}`);
      },
    };
    let canonicalId = "";
    let pendingKeys: string[] = [];
    let exclusionCreated = false;
    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("SELECT version, upload_url_expires_at FROM opening_sources")) {
        const row = baseSql.sources.get(String(values[0]));
        return row ? [{ version: 0, upload_url_expires_at: new Date("2020-01-01T00:00:00.000Z") }] : [];
      }
      if (query.startsWith("SELECT * FROM opening_privacy_exclusions")) {
        return exclusionCreated ? [{ id: "00000000-0000-4000-8000-000000000099", source_id: canonicalId, pending_object_keys: pendingKeys, cleanup_not_before: null }] : [];
      }
      if (query.startsWith("SELECT m.id") || query.startsWith("UPDATE opening_course_knowledge")
        || query.startsWith("UPDATE workspaces SET privacy_epoch")
        || query.startsWith("SELECT version FROM opening_source_versions") || query.startsWith("SELECT image_object_key")
        || query.startsWith("DELETE FROM course_asset_memberships") || query.startsWith("UPDATE opening_source_versions")) {
        return [];
      }
      if (query.startsWith("DELETE FROM opening_sources")) {
        baseSql.sources.delete(String(values[1]));
        return [];
      }
      if (query.startsWith("INSERT INTO opening_privacy_exclusions")) {
        exclusionCreated = true;
        return [];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET asset_deleted_at")) {
        pendingKeys = values[1] as string[];
        return [];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=?")) {
        pendingKeys = values[0] as string[];
        return [];
      }
      if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
        return pendingKeys.length ? [{ id: "00000000-0000-4000-8000-000000000099", source_id: canonicalId, pending_object_keys: pendingKeys, cleanup_not_before: null }] : [];
      }
      if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) return [];
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove")) {
        pendingKeys = pendingKeys.filter(k => k !== values[0]);
        return [];
      }
      return (baseSql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof baseSql, {
      json: baseSql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage);
    const ticket = await svc.beginUpload(principal, {
      name: "listing-retry.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    canonicalId = ticket.source.id;
    const mixedKey = `opening/staging/${canonicalId.replace(/[a-f]/, ch => ch.toUpperCase())}`;
    s3.objects.set(mixedKey, { bytes: pdfBytes, etag: "etag-mixed" });

    // Listing error on delete still removes DB source, but leaves staging receipt pending.
    const firstDelete = await svc.actOnSource(principal, canonicalId, {
      action: "delete",
      expectedVersion: 0,
      expectedMembershipIds: [],
    });
    expect(firstDelete.deleted).toBe(true);
    expect(firstDelete.cleanupPending).toBeGreaterThan(0);
    expect(s3.objects.has(mixedKey)).toBe(true);

    // Retry while listing still fails must keep the receipt pending instead of clearing it.
    const failedRetry = await svc.actOnSource(principal, canonicalId, { action: "retry_cleanup" });
    expect(failedRetry.cleanupPending).toBeGreaterThan(0);
    expect(s3.objects.has(mixedKey)).toBe(true);

    // Once listing completes, retry discovers, deletes, and clears the receipt.
    listShouldFail = false;
    const succeededRetry = await svc.actOnSource(principal, canonicalId, { action: "retry_cleanup" });
    expect(succeededRetry).toMatchObject({ sourceId: canonicalId, deleted: true, cleanupPending: 0, retryAfter: null });
    expect(s3.objects.has(mixedKey)).toBe(false);
    expect(pendingKeys).toEqual([]);
  });

  it("discovers and deletes mixed-case staging objects on a second delete after an earlier listing failure", async () => {
    const baseSql = makeFakeSql();
    const s3 = makeFakeStorage();
    let listShouldFail = true;
    const storage: OpeningStorage = {
      ...s3.storage,
      stagingKey: (id) => `opening/staging/${id}`,
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
      listMatchingStagingKeys: async (canonicalId) => {
        if (listShouldFail) throw new Error("listing temporarily unavailable");
        return [...s3.objects.keys()].filter(key => key.toLowerCase() === `opening/staging/${canonicalId.toLowerCase()}`);
      },
    };
    let canonicalId = "";
    let pendingKeys: string[] = [];
    let exclusionCreated = false;
    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("SELECT version, upload_url_expires_at FROM opening_sources")) {
        const row = baseSql.sources.get(String(values[0]));
        return row ? [{ version: 0, upload_url_expires_at: new Date("2020-01-01T00:00:00.000Z") }] : [];
      }
      if (query.startsWith("SELECT * FROM opening_privacy_exclusions")) {
        return exclusionCreated ? [{
          id: "00000000-0000-4000-8000-000000000099",
          source_id: canonicalId,
          asset_deleted_at: new Date("2020-01-01T00:00:00.000Z"),
          pending_object_keys: pendingKeys,
          cleanup_not_before: null,
        }] : [];
      }
      if (query.startsWith("SELECT m.id") || query.startsWith("UPDATE opening_course_knowledge")
        || query.startsWith("UPDATE workspaces SET privacy_epoch")
        || query.startsWith("SELECT version FROM opening_source_versions") || query.startsWith("SELECT image_object_key")
        || query.startsWith("DELETE FROM course_asset_memberships") || query.startsWith("UPDATE opening_source_versions")) {
        return [];
      }
      if (query.startsWith("DELETE FROM opening_sources")) {
        baseSql.sources.delete(String(values[1]));
        return [];
      }
      if (query.startsWith("INSERT INTO opening_privacy_exclusions")) {
        exclusionCreated = true;
        return [];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET asset_deleted_at")) {
        pendingKeys = values[1] as string[];
        return [];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=?")) {
        pendingKeys = values[0] as string[];
        return [];
      }
      if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
        return pendingKeys.length ? [{ id: "00000000-0000-4000-8000-000000000099", source_id: canonicalId, pending_object_keys: pendingKeys, cleanup_not_before: null }] : [];
      }
      if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) return [];
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove")) {
        pendingKeys = pendingKeys.filter(k => k !== values[0]);
        return [];
      }
      return (baseSql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof baseSql, {
      json: baseSql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage);
    const ticket = await svc.beginUpload(principal, {
      name: "second-delete.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    canonicalId = ticket.source.id;
    const mixedKey = `opening/staging/${canonicalId.replace(/[a-f]/, ch => ch.toUpperCase())}`;
    s3.objects.set(mixedKey, { bytes: pdfBytes, etag: "etag-mixed" });

    // First delete fails listing -> source removed in DB, staging receipt remains pending.
    const firstDelete = await svc.actOnSource(principal, canonicalId, {
      action: "delete",
      expectedVersion: 0,
      expectedMembershipIds: [],
    });
    expect(firstDelete.cleanupPending).toBeGreaterThan(0);
    expect(s3.objects.has(mixedKey)).toBe(true);

    // Second delete succeeds listing, merges & fails S3 delete -> receipt stays pending with mixedKey merged.
    listShouldFail = false;
    const realDelete = storage.deleteObject;
    storage.deleteObject = async (key: string) => {
      if (key === mixedKey) throw new Error("storage busy");
      return realDelete(key);
    };
    const blockedSecondDelete = await svc.actOnSource(principal, canonicalId, {
      action: "delete",
      expectedVersion: 0,
      expectedMembershipIds: [],
    });
    expect(blockedSecondDelete.cleanupPending).toBe(1);
    expect(pendingKeys).toContain(mixedKey);
    expect(s3.objects.has(mixedKey)).toBe(true);

    // Next delete clears both S3 and the merged receipt.
    storage.deleteObject = realDelete;
    const cleanDelete = await svc.actOnSource(principal, canonicalId, {
      action: "delete",
      expectedVersion: 0,
      expectedMembershipIds: [],
    });
    expect(cleanDelete).toMatchObject({ sourceId: canonicalId, deleted: true, cleanupPending: 0, retryAfter: null });
    expect(s3.objects.has(mixedKey)).toBe(false);
    expect(pendingKeys).toEqual([]);
  });

  it("persists discovered mixed-case staging keys before S3 remove when retry_cleanup encounters an empty legacy receipt", async () => {
    const baseSql = makeFakeSql();
    const s3 = makeFakeStorage();
    const storage: OpeningStorage = {
      ...s3.storage,
      stagingKey: (id) => `opening/staging/${id}`,
      finalKey: (id, version) => `opening/sources/${id}/v${version}`,
      listMatchingStagingKeys: async (canonicalId) =>
        [...s3.objects.keys()].filter(key => key.toLowerCase() === `opening/staging/${canonicalId.toLowerCase()}`),
    };
    const sourceId = "00000000-0000-4000-8000-0000000000e1";
    const mixedKey = `opening/staging/${sourceId.slice(0, 6).toUpperCase()}${sourceId.slice(6)}`;
    s3.objects.set(mixedKey, { bytes: pdfBytes, etag: "etag-mixed" });

    // Legacy deletion receipt with empty pending_object_keys = [].
    let pendingKeys: string[] = [];
    const wrappedSql = Object.assign(((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "" || query === "FOR UPDATE") return query;
      if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
        return [{
          id: "00000000-0000-4000-8000-000000000099",
          source_id: sourceId,
          pending_object_keys: pendingKeys,
          cleanup_not_before: null,
        }];
      }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=?")) {
        pendingKeys = [...(values[0] as string[])];
        return [];
      }
      if (query.startsWith("SELECT id, cleanup_not_before FROM opening_privacy_exclusions")) return [];
      if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=array_remove")) {
        pendingKeys = pendingKeys.filter(k => k !== values[0]);
        return [];
      }
      return (baseSql as unknown as (p: TemplateStringsArray, ...v: unknown[]) => unknown)(parts, ...values);
    }) as unknown as typeof baseSql, {
      json: baseSql.json,
      begin: (cb: (tx: Sql) => Promise<unknown>) => cb(wrappedSql as unknown as Sql),
    });

    const realDelete = storage.deleteObject;
    storage.deleteObject = async () => { throw new Error("storage unavailable"); };
    const svc = createOpeningSourceService(wrappedSql as unknown as Sql, storage);

    const failedRetry = await svc.actOnSource(principal, sourceId, { action: "retry_cleanup" });
    expect(failedRetry).toEqual({
      sourceId,
      aiExcluded: true,
      deleted: true,
      cleanupPending: 1,
      retryAfter: null,
    });
    expect(pendingKeys).toEqual([mixedKey]);
    expect(s3.objects.has(mixedKey)).toBe(true);

    storage.deleteObject = realDelete;
    const clearedRetry = await svc.actOnSource(principal, sourceId, { action: "retry_cleanup" });
    expect(clearedRetry).toEqual({
      sourceId,
      aiExcluded: true,
      deleted: true,
      cleanupPending: 0,
      retryAfter: null,
    });
    expect(pendingKeys).toEqual([]);
    expect(s3.objects.has(mixedKey)).toBe(false);
  });

});
