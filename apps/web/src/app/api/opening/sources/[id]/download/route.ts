import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import {
  createOpeningSourceService,
  type DownloadDisposition,
} from "../../../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../../../features/opening/sources/upload-policy";
import { isOpeningDataError } from "../../../../../../features/opening/server/data-services";

type Params = { params: Promise<{ id: string }> };

function storageError(error: unknown): Response | undefined {
  if (error instanceof UploadPolicyError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 });
  }
  if (isOpeningDataError(error, "storage")) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.code === "NOT_FOUND" ? 404 : 503 },
    );
  }
  return undefined;
}

function parseDisposition(raw: string | null): DownloadDisposition {
  return raw === "inline" ? "inline" : "attachment";
}

/**
 * Same-origin download: streams object bytes with Content-Disposition.
 * Contract change (Package A): response is **binary**, not JSON with a MinIO presign URL.
 * Experience should use `/api/opening/sources/:id/download?version=` as `<a href>` (cookies apply).
 * Pass `disposition=inline` for previewable MIME (PDF / image / plain / markdown); default stays attachment.
 * Version metadata is also mirrored on response headers for fetch-based clients.
 */
export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const url = new URL(request.url);
    const raw = url.searchParams.get("version");
    const version = raw === null ? undefined : Number(raw);
    if (version !== undefined && !Number.isInteger(version)) {
      return Response.json(
        { error: { code: "VALIDATION", message: "source version is invalid" } },
        { status: 422 },
      );
    }
    const disposition = parseDisposition(url.searchParams.get("disposition"));
    const id = (await context.params).id;
    const download = await createOpeningSourceService(sql).getDownloadStream(principal, id, version, {
      disposition,
    });
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
