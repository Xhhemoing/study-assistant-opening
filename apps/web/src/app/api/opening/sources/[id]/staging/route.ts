import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../../../features/opening/sources/upload-policy";
import { isOpeningDataError } from "../../../../../../features/opening/server/data-services";

type Params = { params: Promise<{ id: string }> };

function storageError(error: unknown): Response | undefined {
  if (error instanceof UploadPolicyError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (isOpeningDataError(error, "storage")) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.code === "NOT_FOUND" ? 404 : 503 },
    );
  }
  return undefined;
}

/** Same-origin authenticated staging PUT with bounded multipart backpressure. */
export async function PUT(request: Request, context: Params): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = (await context.params).id;
    const service = createOpeningSourceService(sql);
    const target = await service.getStagingPutTarget(principal, id);

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const declared = Number(contentLength);
      if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(declared)) throw new UploadPolicyError("Invalid Content-Length");
      if (declared > target.bytes) throw new UploadPolicyError("请求体过大", 413);
      if (declared < target.bytes) throw new UploadPolicyError("request bytes do not match upload ticket");
    }

    if (!request.body) throw new UploadPolicyError("upload body is required");
    const contentType = request.headers.get("content-type") ?? "";
    await service.putStagingStream(principal, id, { contentType, body: request.body, signal: request.signal });
    return new Response(null, { status: 204 });
  } catch (error) {
    void request.body?.cancel().catch(() => undefined);
    return storageError(error) ?? jsonError(mapDomainError(error));
  }
}
