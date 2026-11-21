import { randomUUID } from "node:crypto";
import { loadOpeningUploadQuota } from "@aistudy/config";
import {
  createOpeningSourceRepository,
  createOpeningSourceActionsRepository,
  createOpeningPrivacyRepository,
  createOpeningKnowledgeRepository,
  readOpeningExamPublicSource,
  resolveLegacySourceFinalKey,
  OpeningSourceError,
  OpeningS3,
  magicMatchesMime,
  type OpeningScope,
  type OpeningStorage,
  type OpeningSourceRepository,
} from "@aistudy/database";
import { sourceActionInputSchema, uploadInputSchema, type SourceActionInput, type SourceActionResult, type SourceRecord, type UploadInput, type UploadTicket } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { validatedUploadStream, validateStoredUpload, UploadPolicyError } from "./upload-policy";
import { isPreviewableMime } from "./preview-mime";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

const STAGING_UPLOAD_LEASE_MS = 900_000;

function normalizeMime(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function stagingUploadUrl(sourceId: string): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  const canonicalId = sourceId.toLowerCase();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PUBLIC_BASE_URL is required in production to mint staging upload URLs");
    }
    return new URL(`/api/opening/sources/${canonicalId}/staging`, "http://127.0.0.1:3000").toString();
  }
  return new URL(`/api/opening/sources/${canonicalId}/staging`, configured).toString();
}

function contentDispositionHeader(filename: string, kind: "attachment" | "inline"): string {
  const fallback = Array.from(filename).map((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code > 126 || ch === '"' || ch === "\\" || ch === ";" ? "_" : ch;
  }).join("") || "download";
  // Header values must be byte strings. Keep Unicode only in RFC 5987's
  // percent-encoded parameter, and replace unpaired UTF-16 surrogates safely.
  const unicodeFilename = new TextDecoder().decode(new TextEncoder().encode(filename));
  const encoded = encodeURIComponent(unicodeFilename).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function contentDispositionAttachment(filename: string): string {
  return contentDispositionHeader(filename, "attachment");
}

export type DownloadDisposition = "attachment" | "inline";

/** Resolve attachment vs inline; non-previewable MIME always stays attachment. */
export function resolveDownloadDisposition(
  mime: string,
  requested: DownloadDisposition = "attachment",
): DownloadDisposition {
  if (requested === "inline" && isPreviewableMime(mime)) return "inline";
  return "attachment";
}


export function createOpeningSourceService(sql: Sql, storage: OpeningStorage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy", accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" }), options: { now?: () => Date } = {}) {
  const sources: OpeningSourceRepository = createOpeningSourceRepository(sql, { quota: loadOpeningUploadQuota(), now: options.now });
  const actions = createOpeningSourceActionsRepository(sql);
  const privacy = createOpeningPrivacyRepository(sql);
  const now = options.now ?? (() => new Date());
  const scopeOf = (p: Principal) => ({ workspaceId: boundWorkspaceId(p), ownerUserId: p.userId });
  const auth = (p: Principal, action: string) => assertAuthorized(p, action as never, { type: "workspace", workspaceId: boundWorkspaceId(p) });
  async function resolveReadableFinalKey(
    scope: OpeningScope,
    rawId: string,
    sourceId: string,
    version: number,
    requireExisting: boolean,
  ): Promise<string> {
    const canonicalKey = storage.finalKey(sourceId, version);
    if (typeof storage.objectExists !== "function") {
      return canonicalKey;
    }
    if (await storage.objectExists(canonicalKey)) {
      return canonicalKey;
    }
    if (rawId !== sourceId) {
      const rawKey = storage.finalKey(rawId, version);
      if (await storage.objectExists(rawKey)) return rawKey;
    }
    const recordedKey = await (sources.resolveLegacyFinalKey
      ? sources.resolveLegacyFinalKey(scope, sourceId, canonicalKey)
      : resolveLegacySourceFinalKey(sql, scope, sourceId, canonicalKey));
    if (recordedKey && await storage.objectExists(recordedKey)) {
      return recordedKey;
    }
    if (requireExisting) {
      throw new OpeningSourceError("NOT_FOUND", "cited source version is unavailable");
    }
    return canonicalKey;
  }
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
    async getStagingPutTarget(p: Principal, id: string): Promise<{ bytes: number; mime: string; expiresAt: string }> {
      auth(p, "source.create");
      const { source, expiresAt } = await sources.getPendingUpload(scopeOf(p), id.toLowerCase());
      return { bytes: source.bytes, mime: source.mime, expiresAt };
    },
    async putStagingStream(
      p: Principal,
      id: string,
      input: { contentType: string; body: ReadableStream<Uint8Array>; signal?: AbortSignal },
    ): Promise<{ ok: true }> {
      let signal: AbortSignal | undefined;
      let uploadAbort: AbortController | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const cancelUpload = () => uploadAbort?.abort();
      try {
        auth(p, "source.create");
        const sourceId = id.toLowerCase();
        const { source, expiresAt } = await sources.getPendingUpload(scopeOf(p), sourceId);
        const requestMime = normalizeMime(input.contentType);
        if (!requestMime || requestMime !== normalizeMime(source.mime)) {
          throw new UploadPolicyError(`request mime ${requestMime || "(missing)"} != expected ${source.mime}`);
        }
        const remaining = new Date(expiresAt).getTime() - now().getTime();
        if (remaining <= 0) throw new UploadPolicyError("上传凭证已过期，请重试上传。");
        uploadAbort = new AbortController();
        signal = uploadAbort.signal;
        if (input.signal?.aborted) cancelUpload();
        else input.signal?.addEventListener("abort", cancelUpload, { once: true });
        deadline = setTimeout(cancelUpload, Math.min(STAGING_UPLOAD_LEASE_MS, remaining));
        deadline.unref();
        const body = validatedUploadStream(input.body, source, signal);
        await storage.putObjectStream(storage.stagingKey(sourceId), body, { mime: source.mime, bytes: source.bytes, signal });
      } catch (error) {
        // Also close the sender on ownership/MIME/expired-lease failures before
        // storage started; the HTTP route and internal callers share this path.
        void input.body.cancel().catch(() => undefined);
        if (error instanceof UploadPolicyError) throw error;
        if (signal?.aborted) throw new UploadPolicyError("上传已取消或凭证已过期，请重试上传。");
        throw error;
      } finally {
        if (deadline) clearTimeout(deadline);
        input.signal?.removeEventListener("abort", cancelUpload);
      }
      return { ok: true };
    },
    /**
     * Compatibility for server imports that already hold bounded bytes.
     * Browser PUTs use putStagingStream; size and MIME still match the ticket.
     */
    async putStaging(
      p: Principal,
      id: string,
      input: { contentType: string; bytes: Uint8Array },
    ): Promise<{ ok: true }> {
      auth(p, "source.create");
      const scope = scopeOf(p);
      const sourceId = id.toLowerCase();
      const source = await sources.get(scope, sourceId);
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
      await storage.putObject(storage.stagingKey(sourceId), input.bytes, { mime: source.mime });
      return { ok: true };
    },
    async completeUpload(p: Principal, id: string): Promise<SourceRecord> {
      auth(p, "source.complete");
      const scope = scopeOf(p);
      const sourceId = id.toLowerCase();
      const source = await sources.get(scope, sourceId);
      if (source.uploadState === "uploaded") return source;
      let key = storage.stagingKey(sourceId);
      let head = await storage.headObject(key);
      if (!head.exists && id !== sourceId) {
        const legacyKey = storage.stagingKey(id);
        const legacyHead = await storage.headObject(legacyKey);
        if (legacyHead.exists) {
          key = legacyKey;
          head = legacyHead;
        }
      }
      if (!head.exists) throw new UploadPolicyError("upload not found; PUT to uploadUrl first");
      const digest = await storage.streamDigest(key, source.bytes + 1);
      if (!magicMatchesMime(digest.firstBytes, source.mime)) throw new UploadPolicyError("stored object magic bytes do not match declared MIME");
      const actual = { bytes: digest.bytes, sha256: digest.sha256, mime: source.mime };
      validateStoredUpload(source, actual);
      const done = await sources.completeWithParseJob(scope, sourceId, {
        key: storage.finalKey(sourceId, source.version),
        payload: { sourceId, sourceVersion: source.version },
        privacyEpoch: await privacy.getWorkspaceEpoch(scope),
        actual,
        beforeComplete: current => storage.copyStagingToFinal(key, storage.finalKey(sourceId, current.version), { expectedEtag: head.etag }),
      });
      await storage.deleteObject(key);
      return done;
    },
    async retryParse(p: Principal, id: string): Promise<SourceRecord> {
      auth(p, "source.complete");
      const scope = scopeOf(p);
      const sourceId = id.toLowerCase();
      const source = await sources.get(scope, sourceId);
      const canonicalFinalKey = storage.finalKey(sourceId, source.version);
      const objectKey = await resolveReadableFinalKey(scope, id, sourceId, source.version, false);
      return sources.retryParseWithJob(scope, sourceId, {
        key: `parse:${sourceId}:v${source.version}:retry:${randomUUID()}`,
        payload: {
          sourceId,
          sourceVersion: source.version,
          ...(objectKey !== canonicalFinalKey ? { objectKey } : {}),
        },
        privacyEpoch: await privacy.getWorkspaceEpoch(scope),
      });
    },
    async getSourceImpact(p: Principal, id: string) { auth(p, "source.read"); return actions.impact(scopeOf(p), id.toLowerCase()); },
    async listSourceDeletions(p: Principal) { auth(p, "source.list"); return actions.listPending(scopeOf(p), now()); },
    async actOnSource(p: Principal, id: string, raw: SourceActionInput): Promise<SourceActionResult> {
      auth(p, "source.delete");
      const sourceId = id.toLowerCase();
      const input = sourceActionInputSchema.parse(raw), scope = scopeOf(p);
      const result = input.action === "retry_cleanup"
        ? { deleted: true, cleanup: await actions.cleanup(scope, sourceId) }
        : await actions.apply(scope, id, input, storage, now());
      if (input.action !== "retry_cleanup") {
        try {
          await createOpeningKnowledgeRepository(sql).reconcileCoursesForSource(scope, {
            sourceId,
            markInvalidated: true,
          });
        } catch {
          // Best-effort sync: source action already committed.
        }
      }
      if (!result.deleted) return { sourceId, aiExcluded: true, deleted: false, cleanupPending: 0, retryAfter: null };
      let released = false;
      for (const key of result.cleanup.keys) {
        try { await storage.deleteObject(key); }
        catch { continue; } // The receipt keeps this failed key visible and retryable.
        const isStagingKey = key.toLowerCase() === storage.stagingKey(sourceId).toLowerCase();
        if (isStagingKey && result.cleanup.notBefore && new Date(result.cleanup.notBefore) > now()) continue;
        if (await actions.cleaned(scope, sourceId, key)) released = true;
      }
      let remaining: { keys: string[]; notBefore: string | null };
      if (released) {
        remaining = { keys: [], notBefore: null };
      } else {
        try {
          remaining = await actions.cleanup(scope, sourceId);
        } catch (error) {
          if (error instanceof OpeningSourceError && error.code === "NOT_FOUND" && result.cleanup.keys.length > 0) {
            // Concurrent cleanup may have already released a temporary connector reservation.
            remaining = { keys: [], notBefore: null };
          } else {
            throw error;
          }
        }
      }
      return { sourceId, aiExcluded: true, deleted: true, cleanupPending: remaining.keys.length,
        retryAfter: remaining.keys.length && remaining.notBefore && new Date(remaining.notBefore) > now() ? remaining.notBefore : null };
    },
    /**
     * Server/worker-oriented download ticket. Still uses MinIO loopback presignGet.
     * Browser must use getDownloadStream / GET .../download (same-origin bytes) instead.
     */
    async getDownloadUrl(p: Principal, id: string, version?: number) {
      auth(p, "source.read");
      const scope = scopeOf(p);
      const sourceId = id.toLowerCase();
      const source = await sources.get(scope, sourceId);
      if (source.uploadState !== "uploaded") throw new OpeningSourceError("CONFLICT", "source is not uploaded");
      const requested = version ?? source.version;
      if (!Number.isInteger(requested) || requested < 0 || requested > source.version) {
        throw new OpeningSourceError("NOT_FOUND", "cited source version is unavailable");
      }
      const key = await resolveReadableFinalKey(scope, id, sourceId, requested, true);
      return {
        url: await storage.presignGet(key, { expiresInSeconds: 900, responseContentDisposition: contentDispositionAttachment(source.name), responseCacheControl: "private, no-store" }),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        version: requested,
        currentVersion: source.version,
        versionMismatch: requested !== source.version,
      };
    },
    /**
     * Same-origin download: GetObject stream + disposition metadata (no MinIO URL to browser).
     */
    async getDownloadStream(
      p: Principal,
      id: string,
      version?: number,
      options?: { disposition?: DownloadDisposition },
    ) {
      auth(p, "source.read");
      const scope = scopeOf(p);
      const sourceId = id.toLowerCase();
      const source = await sources.get(scope, sourceId);
      if (source.uploadState !== "uploaded") throw new OpeningSourceError("CONFLICT", "source is not uploaded");
      const requested = version ?? source.version;
      if (!Number.isInteger(requested) || requested < 0 || requested > source.version) {
        throw new OpeningSourceError("NOT_FOUND", "cited source version is unavailable");
      }
      const publicSource = source.mime === "text/plain" && requested === 0
        ? await readOpeningExamPublicSource(sql, scope, sourceId, requested) : null;
      const downloadKey = !publicSource
        ? await resolveReadableFinalKey(scope, id, sourceId, requested, false)
        : "";
      const object = publicSource ? {
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(publicSource.text));
          controller.close();
        } }),
        contentType: "text/plain", contentLength: publicSource.bytes,
      } : await storage.getObjectStream(downloadKey).catch(async (error) => {
        if (typeof storage.objectExists === "function") throw error;
        const rawKey = id !== sourceId ? storage.finalKey(id, requested) : null;
        if (rawKey) {
          try { return await storage.getObjectStream(rawKey); } catch { /* fall through */ }
        }
        const recordedKey = await (sources.resolveLegacyFinalKey
          ? sources.resolveLegacyFinalKey(scope, sourceId, downloadKey)
          : resolveLegacySourceFinalKey(sql, scope, sourceId, downloadKey));
        if (recordedKey) return storage.getObjectStream(recordedKey);
        throw error;
      });
      const contentType = source.mime || object.contentType;
      const disposition = resolveDownloadDisposition(contentType, options?.disposition ?? "attachment");
      return {
        body: object.body,
        contentType,
        contentLength: object.contentLength ?? source.bytes,
        contentDisposition: contentDispositionHeader(source.name, disposition),
        version: requested,
        currentVersion: source.version,
        versionMismatch: requested !== source.version,
      };
    },
    /**
     * Re-issue same-origin staging PUT lease for a pending source (same id; no new row).
     */
    async reissueUploadTicket(p: Principal, id: string): Promise<UploadTicket> {
      auth(p, "source.create");
      const scope = scopeOf(p);
      return sources.issueUploadTicket(scope, id.toLowerCase(), async current => {
        const uploadUrl = stagingUploadUrl(current.id);
        return { uploadUrl, expiresAt: new Date(now().getTime() + STAGING_UPLOAD_LEASE_MS).toISOString() };
      });
    },
  };
}
export type OpeningSourceService = ReturnType<typeof createOpeningSourceService>;
