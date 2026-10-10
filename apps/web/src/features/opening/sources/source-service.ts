import { randomUUID } from "node:crypto";
import {
  createOpeningSourceRepository,
  createOpeningSourceActionsRepository,
  createOpeningPrivacyRepository,
  OpeningSourceError,
  OpeningS3,
  magicMatchesMime,
  type OpeningStorage,
  type OpeningSourceRepository,
} from "@aistudy/database";
import { sourceActionInputSchema, uploadInputSchema, type SourceActionInput, type SourceActionResult, type SourceRecord, type UploadInput, type UploadTicket } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { validateStoredUpload, UploadPolicyError } from "./upload-policy";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

const STAGING_UPLOAD_LEASE_MS = 900_000;

function normalizeMime(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function stagingUploadUrl(sourceId: string): string {
  return new URL(
    `/api/opening/sources/${sourceId}/staging`,
    process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000",
  ).toString();
}

export function createOpeningSourceService(sql: Sql, storage: OpeningStorage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy", accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" }), options: { now?: () => Date } = {}) {
  const sources: OpeningSourceRepository = createOpeningSourceRepository(sql);
  const actions = createOpeningSourceActionsRepository(sql);
  const privacy = createOpeningPrivacyRepository(sql);
  const now = options.now ?? (() => new Date());
  const scopeOf = (p: Principal) => ({ workspaceId: boundWorkspaceId(p), ownerUserId: p.userId });
  const auth = (p: Principal, action: string) => assertAuthorized(p, action as never, { type: "workspace", workspaceId: boundWorkspaceId(p) });
  return {
    async listSources(p: Principal): Promise<SourceRecord[]> { auth(p, "source.list"); return sources.list(scopeOf(p)); },
    async beginUpload(p: Principal, input: UploadInput): Promise<UploadTicket> {
      auth(p, "source.create");
      const scope = scopeOf(p), source = await sources.create(scope, uploadInputSchema.parse(input));
      return sources.issueUploadTicket(scope, source.id, async current => {
        const uploadUrl = stagingUploadUrl(current.id);
        return { uploadUrl, expiresAt: new Date(now().getTime() + STAGING_UPLOAD_LEASE_MS).toISOString() };
      });
    },
    /**
     * Same-origin staging PUT target metadata (bytes/mime) for request size guards.
     * Rejects missing / wrong-owner / non-pending sources as NOT_FOUND.
     */
    async getStagingPutTarget(p: Principal, id: string): Promise<{ bytes: number; mime: string }> {
      auth(p, "source.create");
      const source = await sources.get(scopeOf(p), id);
      if (source.uploadState !== "pending") {
        throw new OpeningSourceError("NOT_FOUND", "source is not pending");
      }
      return { bytes: source.bytes, mime: source.mime };
    },
    /**
     * Buffer the browser/server body into staging object storage (same-origin PUT).
     * Content-Type and byte length must match the beginUpload record exactly.
     */
    async putStaging(
      p: Principal,
      id: string,
      input: { contentType: string; bytes: Uint8Array },
    ): Promise<{ ok: true }> {
      auth(p, "source.create");
      const scope = scopeOf(p);
      const source = await sources.get(scope, id);
      if (source.uploadState !== "pending") {
        throw new OpeningSourceError("NOT_FOUND", "source is not pending");
      }
      const requestMime = normalizeMime(input.contentType);
      if (!requestMime || requestMime !== normalizeMime(source.mime)) {
        throw new UploadPolicyError(
          `request mime ${requestMime || "(missing)"} != expected ${source.mime}`,
        );
      }
      if (input.bytes.byteLength !== source.bytes) {
        throw new UploadPolicyError(
          `request bytes ${input.bytes.byteLength} != expected ${source.bytes}`,
        );
      }
      await storage.putObject(storage.stagingKey(id), input.bytes, { mime: source.mime });
      return { ok: true };
    },
    async completeUpload(p: Principal, id: string): Promise<SourceRecord> {
      auth(p, "source.complete"); const scope = scopeOf(p); const source = await sources.get(scope, id); if (source.uploadState === "uploaded") return source;
      const key = storage.stagingKey(id); const head = await storage.headObject(key); if (!head.exists) throw new UploadPolicyError("upload not found; PUT to uploadUrl first");
      const digest = await storage.streamDigest(key, source.bytes + 1); if (!magicMatchesMime(digest.firstBytes, source.mime)) throw new UploadPolicyError("stored object magic bytes do not match declared MIME");
      const actual = { bytes: digest.bytes, sha256: digest.sha256, mime: source.mime }; validateStoredUpload(source, actual);
      const done = await sources.completeWithParseJob(scope, id, { key: storage.finalKey(id, source.version), payload: { sourceId: id, sourceVersion: source.version }, privacyEpoch: await privacy.getWorkspaceEpoch(scope), actual,
        beforeComplete: current => storage.copyStagingToFinal(key, storage.finalKey(id, current.version), { expectedEtag: head.etag }),
      }); await storage.deleteObject(key); return done;
    },
    async retryParse(p: Principal, id: string): Promise<SourceRecord> {
      auth(p, "source.complete");
      const scope = scopeOf(p);
      const source = await sources.get(scope, id);
      return sources.retryParseWithJob(scope, id, {
        key: `parse:${id}:v${source.version}:retry:${randomUUID()}`,
        payload: { sourceId: id, sourceVersion: source.version },
        privacyEpoch: await privacy.getWorkspaceEpoch(scope),
      });
    },
    async getSourceImpact(p: Principal, id: string) { auth(p, "source.read"); return actions.impact(scopeOf(p), id); },
    async listSourceDeletions(p: Principal) { auth(p, "source.list"); return actions.listPending(scopeOf(p), now()); },
    async actOnSource(p: Principal, id: string, raw: SourceActionInput): Promise<SourceActionResult> {
      auth(p, "source.delete");
      const input = sourceActionInputSchema.parse(raw), scope = scopeOf(p);
      const result = input.action === "retry_cleanup"
        ? { deleted: true, cleanup: await actions.cleanup(scope, id) }
        : await actions.apply(scope, id, input, storage, now());
      if (!result.deleted) return { sourceId: id, aiExcluded: true, deleted: false, cleanupPending: 0, retryAfter: null };
      for (const key of result.cleanup.keys) {
        try { await storage.deleteObject(key); }
        catch { continue; } // The receipt keeps this failed key visible and retryable.
        if (key === storage.stagingKey(id) && result.cleanup.notBefore && new Date(result.cleanup.notBefore) > now()) continue;
        await actions.cleaned(scope, id, key);
      }
      const remaining = await actions.cleanup(scope, id);
      return { sourceId: id, aiExcluded: true, deleted: true, cleanupPending: remaining.keys.length,
        retryAfter: remaining.keys.length && remaining.notBefore && new Date(remaining.notBefore) > now() ? remaining.notBefore : null };
    },
    async getDownloadUrl(p: Principal, id: string, version?: number) {
      auth(p, "source.read");
      const source = await sources.get(scopeOf(p), id);
      if (source.uploadState !== "uploaded") throw new OpeningSourceError("CONFLICT", "source is not uploaded");
      const requested = version ?? source.version;
      if (!Number.isInteger(requested) || requested < 0 || requested > source.version) {
        throw new OpeningSourceError("NOT_FOUND", "cited source version is unavailable");
      }
      const key = storage.finalKey(id, requested);
      if (!(await storage.objectExists(key))) {
        throw new OpeningSourceError("NOT_FOUND", "cited source version is unavailable");
      }
      return {
        url: await storage.presignGet(key, { expiresInSeconds: 900, responseContentDisposition: `attachment; filename="${source.name}"`, responseCacheControl: "private, no-store" }),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        version: requested,
        currentVersion: source.version,
        versionMismatch: requested !== source.version,
      };
    },
  };
}
export type OpeningSourceService = ReturnType<typeof createOpeningSourceService>;
