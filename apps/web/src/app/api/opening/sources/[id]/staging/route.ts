import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningRawBody } from "../../../../../../features/opening/request-body";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../../../features/opening/sources/upload-policy";
import { OpeningStorageError } from "@aistudy/database";

type Params = { params: Promise<{ id: string }> };

function storageError(error: unknown): Response | undefined {
  if (error instanceof UploadPolicyError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: 400 },
    );
  }
  if (error instanceof OpeningStorageError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.code === "NOT_FOUND" ? 404 : 503 },
    );
  }
  return undefined;
}

/** Same-origin staging PUT: cookie auth + body → OpeningS3.putObject(stagingKey). */
export async function PUT(request: Request, context: Params): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = (await context.params).id;
    const service = createOpeningSourceService(sql);
    const target = await service.getStagingPutTarget(principal, id);

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const declared = Number(contentLength);
      if (Number.isInteger(declared) && declared > target.bytes) {
        return Response.json(
          { error: { code: "VALIDATION", message: "请求体过大" } },
          { status: 413 },
        );
      }
    }

    const body = await readOpeningRawBody(request, target.bytes);
    const contentType = request.headers.get("content-type") ?? "";
    await service.putStaging(principal, id, { contentType, bytes: body });
    return new Response(null, { status: 204 });
  } catch (error) {
    return storageError(error) ?? jsonError(mapDomainError(error));
  }
}
