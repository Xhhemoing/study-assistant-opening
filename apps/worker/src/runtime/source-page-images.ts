import type { Sql } from "postgres";
import { OpeningS3, OpeningSourceError } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import { renderPdfPageImages } from "../parsers/pdf-page-images";

/** Only server-validated versions/pages; never accept user URLs or object keys. */
export function createSourcePageImages(sql: Sql, storage: OpeningS3) {
  return async (scope: Scope, input: { sourceIds: string[]; sourceVersions: Record<string, number>; physicalPage: number }) => {
    const images = [];
    for (const sourceId of input.sourceIds) {
      const version = input.sourceVersions[sourceId];
      if (version === undefined) throw new OpeningSourceError("CONFLICT", "材料版本尚未确认");
      const rows = await sql`SELECT s.mime,s.bytes FROM opening_sources s
        JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
        WHERE s.id=${sourceId} AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
        AND EXISTS (SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=${version} AND c.page=${input.physicalPage})`;
      // A page selection is valid when any selected source contains it. Other
      // selected sources can still contribute text, but do not have to share
      // the same physical page or file format.
      if (!rows.length || rows[0]!.mime !== "application/pdf") continue;
      if (images.length >= 3) throw new OpeningSourceError("VALIDATION", "视觉分析每轮最多指定三份 PDF；请分批分析");
      const url = await storage.presignGet(storage.finalKey(sourceId, version), { expiresInSeconds: 60, responseContentDisposition: "attachment", responseCacheControl: "private, no-store" });
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error("原件读取失败，未发送模型请求");
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > 50 * 1024 * 1024) throw new Error("原件超出视觉分析大小限制");
        chunks.push(chunk);
      }
      images.push(...await renderPdfPageImages(Buffer.concat(chunks), [{ sourceId, physicalPage: input.physicalPage }]));
    }
    return images;
  };
}
export function openingPageStorage() {
  return new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" });
}
