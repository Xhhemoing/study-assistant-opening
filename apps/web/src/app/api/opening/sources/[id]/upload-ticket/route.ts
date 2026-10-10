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
 * Re-issue same-origin staging PUT ticket for a pending source (same id).
 * Non-pending → 409; missing / wrong workspace → 404.
 */
export async function POST(request: Request, context: Params): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const id = (await context.params).id;
    const ticket = await createOpeningSourceService(sql).reissueUploadTicket(principal, id);
    return Response.json(ticket);
  } catch (error) {
    return storageError(error) ?? jsonError(mapDomainError(error));
  }
}
