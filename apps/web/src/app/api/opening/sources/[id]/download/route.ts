import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { OpeningStorageError } from "@aistudy/database";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../../../features/opening/sources/upload-policy";

type Params = { params: Promise<{ id: string }> };

function storageError(error: unknown): Response | undefined {
  if (error instanceof UploadPolicyError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 });
  }
  if (error instanceof OpeningStorageError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.code === "NOT_FOUND" ? 404 : 503 },
    );
  }
  return undefined;
}

/**
 * Same-origin download: streams object bytes with Content-Disposition.
 * Contract change (Package A): response is **binary**, not JSON with a MinIO presign URL.
 * Experience should use `/api/opening/sources/:id/download?version=` as `<a href>` (cookies apply).
 * Version metadata is also mirrored on response headers for fetch-based clients.
 */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const raw = new URL(request.url).searchParams.get("version");
    const version = raw === null ? undefined : Number(raw);
    if (version !== undefined && !Number.isInteger(version)) {
      return Response.json(
        { error: { code: "VALIDATION", message: "source version is invalid" } },
        { status: 422 },
      );
    }
    const id = (await context.params).id;
    const download = await createOpeningSourceService(sql).getDownloadStream(principal, id, version);
    const headers = new Headers({
      "Content-Type": download.contentType,
      "Content-Disposition": download.contentDisposition,
      "Cache-Control": "private, no-store",
      "X-Opening-Source-Version": String(download.version),
      "X-Opening-Source-Current-Version": String(download.currentVersion),
      "X-Opening-Source-Version-Mismatch": download.versionMismatch ? "1" : "0",
    });
    if (download.contentLength !== undefined) {
      headers.set("Content-Length", String(download.contentLength));
    }
    return new Response(download.body, { status: 200, headers });
  } catch (error) {
    return storageError(error) ?? jsonError(mapDomainError(error));
  }
}
