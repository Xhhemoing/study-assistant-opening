import "server-only";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { uploadInputSchema } from "@aistudy/contracts";
import type { Principal } from "../../../lib/authorization";
import { createOpeningSourceService } from "../sources/source-service";
import { isOpeningDataError } from "../server/data-services";

// The uploader accepts UUID operation IDs. UUIDv5 maps arbitrary client keys into
// that existing primary key, separately for each owner and workspace.
function uploadIdFor(principal: Principal, key: string) {
  const digest = createHash("sha1")
    .update(Buffer.from(principal.workspaceId.replaceAll("-", ""), "hex"))
    .update(JSON.stringify(["opening-text-capture", principal.userId, key])).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

export async function saveCaptureSource(sql: Sql, principal: Principal, name: string, markdown: string, clientKey?: string) {
  const bytes = new TextEncoder().encode(markdown);
  const uploadId = clientKey ? uploadIdFor(principal, clientKey) : undefined;
  const input = uploadInputSchema.parse({ name, mime: "text/markdown", bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), uploadId });
  const sources = createOpeningSourceService(sql);
  try {
    const { source } = await sources.beginUpload(principal, input);
    await sources.putStaging(principal, source.id, { bytes, contentType: input.mime });
    const saved = await sources.completeUpload(principal, source.id);
    return { sourceId: saved.id, name: saved.name, bytes: saved.bytes, replayed: false };
  } catch (error) {
    if (!uploadId || !isOpeningDataError(error, "source") || !["CONFLICT", "NOT_FOUND"].includes(error.code)) throw error;
    // Completed uploads cannot receive another staging ticket. Only recover a
    // matching, still-available upload (including a retry after task creation failed).
    const [saved] = await sql`SELECT s.id FROM opening_sources s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ${uploadId} AND s.workspace_id = ${principal.workspaceId} AND w.owner_user_id = ${principal.userId}
        AND s.version = 0 AND s.upload_state = 'uploaded' AND s.name = ${name} AND s.mime = ${input.mime}
        AND s.bytes = ${input.bytes} AND s.sha256 = ${input.sha256}
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.source_id = s.id)`;
    if (!saved) throw error;
    return { sourceId: uploadId, name, bytes: input.bytes, replayed: true };
  }
}
