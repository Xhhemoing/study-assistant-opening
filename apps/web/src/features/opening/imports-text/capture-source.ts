import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { uploadInputSchema } from "@aistudy/contracts";
import type { Principal } from "../../../lib/authorization";
import { createOpeningSourceService } from "../sources/source-service";
import { UploadPolicyError } from "../sources/upload-policy";
import { isOpeningDataError } from "../server/data-services";
import type { prepareCapture } from "./markdown";
import { finishCaptureInTransaction } from "./retell-task";

function isSourceUnavailable(error: unknown) {
  return isOpeningDataError(error, "source") && (error.code === "CONFLICT" || error.code === "NOT_FOUND");
}

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
  prepared: ReturnType<typeof prepareCapture>,
  clientKey?: string,
  scheduleNextDayRetell = true,
  courseId: string | null = null,
  timeZone?: string,
) {
  const bytes = new TextEncoder().encode(prepared.markdown);
  // A one-off course capture still needs a durable binding through completion.
  const key = clientKey ?? (courseId ? randomUUID() : undefined);
  const uploadId = key ? uploadIdFor(principal, key, scheduleNextDayRetell) : undefined;
  const oppositeUploadId = key ? uploadIdFor(principal, key, !scheduleNextDayRetell) : undefined;
  const capture = oppositeUploadId ? {
    oppositeUploadId,
    intent: {
      courseId,
      scheduleNextDayRetell,
      title: prepared.title,
      timeZone: scheduleNextDayRetell ? timeZone ?? null : null,
      inputDigest: createHash("sha256").update(JSON.stringify([prepared.normalizedInput, scheduleNextDayRetell ? timeZone ?? null : null])).digest("hex"),
    },
  } : undefined;
  const input = uploadInputSchema.parse({
    name: prepared.name,
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
    const completed = await sources.completeCaptureUpload(principal, source.id, async tx => {
      await finishCaptureInTransaction(tx, { workspaceId: principal.workspaceId, ownerUserId: principal.userId }, {
        sourceId: source.id, title: prepared.title, courseId, timeZone, scheduleNextDayRetell,
      });
    });
    return { sourceId: completed.source.id, name: completed.source.name, bytes: completed.source.bytes, replayed: completed.replayed };
  } catch (error) {
    const stagingUnavailable = error instanceof UploadPolicyError
      || (isOpeningDataError(error, "storage") && error.code === "NOT_FOUND");
    if (!capture || (!stagingUnavailable && !isSourceUnavailable(error))) throw error;
    // Another exact replay may have completed after this request reserved the pending row.
    const saved = await sources.captureSource(principal, input, { ...capture, completedOnly: true }).catch(recheck => {
      if (isSourceUnavailable(recheck)) throw error;
      throw recheck;
    });
    return { sourceId: saved.id, name: saved.name, bytes: saved.bytes, replayed: true };
  }
}
