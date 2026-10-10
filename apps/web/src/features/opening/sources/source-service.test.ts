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
  const jobEpochs: number[] = [];
  let historyRevision = 0;
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    // Nested postgres.js fragments evaluate as standalone tagged calls before the outer query composes.
    if (query === "FALSE" || query.startsWith("p.privacy_source_ids") || query.startsWith("p.root_observation_id")) return query;
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

});
