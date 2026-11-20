import "server-only";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { uploadInputSchema } from "@aistudy/contracts";
import type { Principal } from "../../../lib/authorization";
import { createOpeningSourceService } from "../sources/source-service";
import { isOpeningDataError } from "../server/data-services";

// The uploader accepts UUID operation IDs. UUIDv5 maps arbitrary client keys
// and scheduling intent into that primary key, separately per owner and workspace.
function uploadIdFor(principal: Principal, key: string, scheduleNextDayRetell: boolean) {
  const mode = scheduleNextDayRetell ? "retell" : "source-only";
  const digest = createHash("sha1")
    .update(Buffer.from(principal.workspaceId.replaceAll("-", ""), "hex"))
    .update(JSON.stringify(["opening-text-capture", principal.userId, key, mode])).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

export async function saveCaptureSource(
  sql: Sql,
  principal: Principal,
  name: string,
  markdown: string,
  clientKey?: string,
  scheduleNextDayRetell = true,
  courseId: string | null = null,
) {
  const bytes = new TextEncoder().encode(markdown);
  const uploadId = clientKey ? uploadIdFor(principal, clientKey, scheduleNextDayRetell) : undefined;
  const oppositeUploadId = clientKey ? uploadIdFor(principal, clientKey, !scheduleNextDayRetell) : undefined;
  const capture = oppositeUploadId ? { oppositeUploadId, intent: { courseId, scheduleNextDayRetell } } : undefined;
  const input = uploadInputSchema.parse({
    name,
    mime: "text/markdown",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    uploadId,
  });
  const sources = createOpeningSourceService(sql);
  const source = capture
    ? await sources.captureSource(principal, input, capture)
    : (await sources.beginUpload(principal, input)).source;
  if (source.uploadState === "uploaded") {
    return { sourceId: source.id, name: source.name, bytes: source.bytes, replayed: true };
  }
  try {
    if (capture) await sources.reissueUploadTicket(principal, source.id);
    await sources.putStaging(principal, source.id, { bytes, contentType: input.mime });
    const saved = await sources.completeUpload(principal, source.id);
    return { sourceId: saved.id, name: saved.name, bytes: saved.bytes, replayed: false };
  } catch (error) {
    if (!capture || !isOpeningDataError(error, "source") || !["CONFLICT", "NOT_FOUND"].includes(error.code)) throw error;
    // Another exact replay may have completed after this request reserved the pending row.
    const saved = await sources.captureSource(principal, input, { ...capture, completedOnly: true });
    return { sourceId: saved.id, name: saved.name, bytes: saved.bytes, replayed: true };
  }
}
