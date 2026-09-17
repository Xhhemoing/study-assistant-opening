import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { OpeningS3, OpeningSourceError } from "@aistudy/database";
import { UploadPolicyError } from "../../apps/web/src/features/opening/sources/upload-policy";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

/**
 * Guarded integration gate for I01 (plan 02-ingestion.md): real portable
 * PostgreSQL (OPENING_TEST_DB=1 + OPENING_TEST_DATABASE_URL) and real MinIO
 * (RELEASE.2025-04-22T22-12-26Z at 127.0.0.1:9000, bucket aistudy).
 * Acceptance: original bytes must round-trip before this slice is done.
 */
const minio = new OpeningS3({
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "aistudy",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
  forcePathStyle: true,
});

let fixture: OpeningFixture;
let svc: ReturnType<typeof createOpeningSourceService>;
let principal: { userId: string; workspaceId: string; sessionId: string };
let otherPrincipal: { userId: string; workspaceId: string; sessionId: string };
const trackedKeys: string[] = [];

const pdfBytes = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.alloc(200, 0x78),
]);
const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");
const jpegBytes = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(204, 0x11),
]);
const jpegSha = createHash("sha256").update(jpegBytes).digest("hex");

async function beginPdf() {
  const ticket = await svc.beginUpload(principal, {
    name: "synthetic.pdf",
    mime: "application/pdf",
    bytes: pdfBytes.length,
    sha256: pdfSha,
  });
  trackedKeys.push(minio.stagingKey(ticket.source.id));
  trackedKeys.push(minio.finalKey(ticket.source.id, ticket.source.version));
  return ticket;
}

beforeAll(async () => {
  fixture = await createOpeningFixture();
  svc = createOpeningSourceService(fixture.sql, minio);
  principal = {
    userId: fixture.scope.ownerUserId,
    workspaceId: fixture.scope.workspaceId,
    sessionId: "integration",
  };
  otherPrincipal = {
    userId: fixture.otherScope.ownerUserId,
    workspaceId: fixture.otherScope.workspaceId,
    sessionId: "integration",
  };
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  for (const key of [...new Set(trackedKeys)]) {
    await minio.deleteObject(key);
  }
  await fixture?.close();
});

describe("opening signed upload against real MinIO + PostgreSQL (guarded)", () => {
  it("completes a verified upload and round-trips the original bytes", async () => {
    const ticket = await beginPdf();
    const put = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes,
    });
    expect(put.status).toBe(200);

    const record = await svc.completeUpload(principal, ticket.source.id);
    expect(record.uploadState).toBe("uploaded");
    expect(record.parseState).toBe("not_started");

    const jobs = await fixture.sql`
      SELECT count(*)::int AS count FROM opening_jobs
      WHERE kind = 'parse' AND payload->>'sourceId' = ${ticket.source.id}
    `;
    expect(jobs[0].count).toBe(1);

    const download = await svc.getDownloadUrl(principal, ticket.source.id);
    const roundTrip = Buffer.from(await (await fetch(download.url)).arrayBuffer());
    expect(roundTrip.equals(pdfBytes)).toBe(true);
  });

  it("returns the original state on duplicate completion without a second job", async () => {
    const ticket = await beginPdf();
    await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes,
    });
    await svc.completeUpload(principal, ticket.source.id);
    const replay = await svc.completeUpload(principal, ticket.source.id);
    expect(replay.uploadState).toBe("uploaded");
    const jobs = await fixture.sql`
      SELECT count(*)::int AS count FROM opening_jobs
      WHERE kind = 'parse' AND payload->>'sourceId' = ${ticket.source.id}
    `;
    expect(jobs[0].count).toBe(1);
  });

  it("keeps another workspace's source invisible", async () => {
    const ticket = await beginPdf();
    await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes,
    });
    await expect(
      svc.completeUpload(otherPrincipal, ticket.source.id),
    ).rejects.toThrow(OpeningSourceError);
  });

  it("rejects completion when nothing was uploaded", async () => {
    const ticket = await beginPdf();
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      UploadPolicyError,
    );
  });

  it("rejects a MIME spoof by magic bytes, leaving the source pending", async () => {
    const ticket = await svc.beginUpload(principal, {
      name: "synthetic.pdf",
      mime: "application/pdf",
      bytes: jpegBytes.length,
      sha256: jpegSha,
    });
    trackedKeys.push(minio.stagingKey(ticket.source.id));
    await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: jpegBytes,
    });
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /magic bytes/i,
    );
    const states = await fixture.sql`
      SELECT upload_state FROM opening_sources WHERE id = ${ticket.source.id}
    `;
    expect(states[0].upload_state).toBe("pending");
  });

  it("rejects a declared sha mismatch", async () => {
    const ticket = await svc.beginUpload(principal, {
      name: "synthetic.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: "a".repeat(64),
    });
    trackedKeys.push(minio.stagingKey(ticket.source.id));
    await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes,
    });
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /sha256/i,
    );
  });

  it("rejects a bytes mismatch", async () => {
    const ticket = await beginPdf();
    const shortUrl = await minio.presignPut(minio.stagingKey(ticket.source.id), {
      mime: "application/pdf",
      bytes: 10,
      expiresInSeconds: 900,
    });
    await fetch(shortUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes.subarray(0, 10),
    });
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /bytes/i,
    );
  });

  it("rejects a re-PUT staging object whose bytes changed under the ticket", async () => {
    const ticket = await beginPdf();
    const changed = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(200, 0x99),
    ]);
    for (const body of [pdfBytes, changed]) {
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body,
      });
      expect(put.status).toBe(200);
    }
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /sha256/i,
    );
  });

  it("refuses a download URL for a pending source", async () => {
    const ticket = await beginPdf();
    await expect(svc.getDownloadUrl(principal, ticket.source.id)).rejects.toThrow(
      OpeningSourceError,
    );
  });
});
