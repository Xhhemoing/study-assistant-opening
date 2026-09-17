import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { OpeningStorageError } from "@aistudy/database";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";
import { UploadPolicyError } from "../../../../../../features/opening/sources/upload-policy";
type Params = { params: Promise<{ id: string }> };
function storageError(error: unknown): Response | undefined {
  if (error instanceof UploadPolicyError) return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 });
  if (error instanceof OpeningStorageError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 503 });
  return undefined;
}
export async function GET(request: Request, context: Params): Promise<Response> {
  try { const { principal, sql } = await requireOpeningScope(request); return Response.json(await createOpeningSourceService(sql).getDownloadUrl(principal, (await context.params).id)); }
  catch (error) { return storageError(error) ?? jsonError(mapDomainError(error)); }
}
