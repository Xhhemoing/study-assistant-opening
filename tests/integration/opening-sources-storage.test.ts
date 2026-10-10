import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningTestStorage, pdfBytes, pdfSha, jpegBytes, jpegSha } from "./opening-storage-fixture";
import { OpeningSourceError } from "@aistudy/database";
import { UploadPolicyError } from "../../apps/web/src/features/opening/sources/upload-policy";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

/** I01: guarded PostgreSQL and real MinIO from explicit S3_* configuration.
 * Original uploaded bytes must round-trip unchanged.
 */
const minio = createOpeningTestStorage();

let fixture: OpeningFixture;
let svc: ReturnType<typeof createOpeningSourceService>;
let principal: { userId: string; workspaceId: string; sessionId: string };
let otherPrincipal: { userId: string; workspaceId: string; sessionId: string };
const trackedKeys: string[] = [];

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
    expect(ticket.uploadUrl).toContain(`/api/opening/sources/${ticket.source.id}/staging`);
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf",
      bytes: pdfBytes,
    });

    const record = await svc.completeUpload(principal, ticket.source.id);
    expect(record.uploadState).toBe("uploaded");
    // completeWithParseJob sets queued + opens one parse job (asserted below).
    expect(record.parseState).toBe("queued");

    const jobs = await fixture.sql`
      SELECT count(*)::int AS count FROM opening_jobs
      WHERE kind = 'parse' AND payload->>'sourceId' = ${ticket.source.id}
    `;
    expect(jobs[0]?.count).toBe(1);

    const download = await svc.getDownloadUrl(principal, ticket.source.id);
    const roundTrip = Buffer.from(await (await fetch(download.url)).arrayBuffer());
    expect(roundTrip.equals(pdfBytes)).toBe(true);
  });

  it("returns the original state on duplicate completion without a second job", async () => {
    const ticket = await beginPdf();
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf",
      bytes: pdfBytes,
    });
    await svc.completeUpload(principal, ticket.source.id);
    const replay = await svc.completeUpload(principal, ticket.source.id);
    expect(replay.uploadState).toBe("uploaded");
    const jobs = await fixture.sql`
      SELECT count(*)::int AS count FROM opening_jobs
      WHERE kind = 'parse' AND payload->>'sourceId' = ${ticket.source.id}
    `;
    expect(jobs[0]?.count).toBe(1);
  });

  it("keeps another workspace's source invisible", async () => {
    const ticket = await beginPdf();
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf",
      bytes: pdfBytes,
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
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf",
      bytes: jpegBytes,
    });
    await expect(svc.completeUpload(principal, ticket.source.id)).rejects.toThrow(
      /magic bytes/i,
    );
    const states = await fixture.sql`
      SELECT upload_state FROM opening_sources WHERE id = ${ticket.source.id}
    `;
    expect(states[0]?.upload_state).toBe("pending");
  });

  it("rejects a declared sha mismatch", async () => {
    const ticket = await svc.beginUpload(principal, {
      name: "synthetic.pdf",
      mime: "application/pdf",
      bytes: pdfBytes.length,
      sha256: "a".repeat(64),
    });
    trackedKeys.push(minio.stagingKey(ticket.source.id));
    await svc.putStaging(principal, ticket.source.id, {
      contentType: "application/pdf",
      bytes: pdfBytes,
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
      await svc.putStaging(principal, ticket.source.id, {
        contentType: "application/pdf",
        bytes: body,
      });
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
