import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { createOpeningSourceService } from "./source-service";
import { OpeningSourceError, type OpeningStorage } from "@aistudy/database";
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
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
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
    if (query.startsWith("SELECT id FROM workspaces")) return [{ id: values[0] }];
    if (query.startsWith("INSERT INTO opening_source_versions")) return [];
    if (query.startsWith("UPDATE opening_sources SET upload_url_expires_at")) {
      const row = sources.get(values[1] as string);
      if (row) row.upload_url_expires_at = values[0];
      return [];
    }
    if (query.startsWith("UPDATE opening_sources")) {
      const [id, workspaceId] = values as [string, string];
      const row = sources.get(id);
      if (row && row.workspace_id === workspaceId && row.upload_state === "pending") {
        row.upload_state = "uploaded";
        return [row];
      }
      return [];
    }
    if (query.startsWith("INSERT INTO opening_jobs")) {
      jobInserts += 1;
      return [{ id: values[0], state: "queued" }];
    }
    if (query.startsWith("INSERT INTO opening_outbox")) {
      outboxInserts += 1;
      return [];
    }
    throw new Error(`unexpected sql: ${query}`);
  }) as unknown as Sql & {
    counts(): { jobInserts: number; outboxInserts: number };
    sources: Map<string, FakeRow>;
  };
  tag.json = ((value: unknown) => value) as never;
  tag.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(tag as unknown as Sql)) as never;
  tag.counts = () => ({ jobInserts, outboxInserts });
  tag.sources = sources;
  return tag;
}

function makeFakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let etagCounter = 0;
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
    deleteObject: async (key) => {
      objects.delete(key);
    },
    objectExists: async (key) => objects.has(key),
  };
  const put = (key: string, bytes: Uint8Array) => {
    etagCounter += 1;
    objects.set(key, { bytes, etag: `etag-${etagCounter}` });
  };
  return { storage, put, has: (key: string) => objects.has(key) };
}

function setup() {
  const sql = makeFakeSql();
  const { storage, put, has } = makeFakeStorage();
  const svc = createOpeningSourceService(sql, storage);
  return { svc, sql, put, has };
}

describe("opening signed upload service", () => {
  it("records the actual signed URL expiry when signing and return times differ", async () => {
    const sql = makeFakeSql(), { storage } = makeFakeStorage();
    storage.presignPut = async () => "https://s3.invalid/object?X-Amz-Date=20260930T011000Z&X-Amz-Expires=900";
    const svc = createOpeningSourceService(sql, storage, { now: () => new Date("2026-09-30T01:12:00Z") });
    const ticket = await svc.beginUpload(principal, { name: "signed.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    expect(ticket.expiresAt).toBe("2026-09-30T01:25:00.000Z");
    expect(sql.sources.get(ticket.source.id)?.upload_url_expires_at).toEqual(new Date(ticket.expiresAt));
  });
  it("persists the signing lifetime after a delayed signature instead of using source creation", async () => {
    const sql = makeFakeSql(), { storage } = makeFakeStorage();
    let time = new Date("2026-09-30T01:00:00Z");
    const sign = storage.presignPut;
    storage.presignPut = async (...args) => { time = new Date("2026-09-30T01:10:00Z"); return sign(...args); };
    const svc = createOpeningSourceService(sql, storage, { now: () => time });
    const ticket = await svc.beginUpload(principal, { name: "slow.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha });
    expect(ticket.expiresAt).toBe("2026-09-30T01:25:00.000Z");
    expect(sql.sources.get(ticket.source.id)?.upload_url_expires_at).toEqual(new Date(ticket.expiresAt));
  });
  it("returns a presigned ticket against the staging key", async () => {
    const { svc } = setup();
    const ticket = await svc.beginUpload(principal, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: pdfSha,
    });
    expect(ticket.uploadUrl).toMatch(/^fake:\/\/put\/staging\//);
    expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());
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
});
