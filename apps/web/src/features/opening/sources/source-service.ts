import {
  createOpeningSourceRepository,
  OpeningSourceError,
  OpeningS3,
  magicMatchesMime,
  type OpeningStorage,
  type OpeningSourceRepository,
} from "@aistudy/database";
import { uploadInputSchema, type SourceRecord, type UploadInput, type UploadTicket } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { validateStoredUpload, UploadPolicyError } from "./upload-policy";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

export function createOpeningSourceService(sql: Sql, storage: OpeningStorage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy", accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" })) {
  const sources: OpeningSourceRepository = createOpeningSourceRepository(sql);
  const scopeOf = (p: Principal) => ({ workspaceId: boundWorkspaceId(p), ownerUserId: p.userId });
  const auth = (p: Principal, action: string) => assertAuthorized(p, action as never, { type: "workspace", workspaceId: boundWorkspaceId(p) });
  return {
    async listSources(p: Principal): Promise<SourceRecord[]> { auth(p, "source.list"); return sources.list(scopeOf(p)); },
    async beginUpload(p: Principal, input: UploadInput): Promise<UploadTicket> { auth(p, "source.create"); const source = await sources.create(scopeOf(p), uploadInputSchema.parse(input)); const key = storage.stagingKey(source.id); return { source, uploadUrl: await storage.presignPut(key, { mime: source.mime, bytes: source.bytes, expiresInSeconds: 900 }), expiresAt: new Date(Date.now() + 900000).toISOString() }; },
    async completeUpload(p: Principal, id: string): Promise<SourceRecord> {
      auth(p, "source.complete"); const scope = scopeOf(p); const source = await sources.get(scope, id); if (source.uploadState === "uploaded") return source;
      const key = storage.stagingKey(id); const head = await storage.headObject(key); if (!head.exists) throw new UploadPolicyError("upload not found; PUT to uploadUrl first");
      const digest = await storage.streamDigest(key, source.bytes + 1); if (!magicMatchesMime(digest.firstBytes, source.mime)) throw new UploadPolicyError("stored object magic bytes do not match declared MIME");
      const actual = { bytes: digest.bytes, sha256: digest.sha256, mime: source.mime }; validateStoredUpload(source, actual);
      await storage.copyStagingToFinal(key, storage.finalKey(id, source.version), { expectedEtag: head.etag });
      const done = await sources.completeWithParseJob(scope, id, { key: storage.finalKey(id, source.version), payload: { sourceId: id }, privacyEpoch: 0, actual }); await storage.deleteObject(key); return done;
    },
    async getDownloadUrl(p: Principal, id: string) { auth(p, "source.read"); const source = await sources.get(scopeOf(p), id); if (source.uploadState !== "uploaded") throw new OpeningSourceError("CONFLICT", "source is not uploaded"); return { url: await storage.presignGet(storage.finalKey(id, source.version), { expiresInSeconds: 900, responseContentDisposition: `attachment; filename="${source.name}"`, responseCacheControl: "private, no-store" }), expiresAt: new Date(Date.now() + 900000).toISOString() }; },
  };
}
export type OpeningSourceService = ReturnType<typeof createOpeningSourceService>;
