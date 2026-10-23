import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createPhotoRecognitionService } from "../../../../../features/opening/practice/photo-recognition-service";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const query = new URL(request.url).searchParams;
    const version = query.get("sourceVersion");
    const input = { sourceId: query.get("sourceId"), sourceVersion: version !== null && /^\d+$/.test(version) ? Number(version) : null };
    return Response.json(await createPhotoRecognitionService(sql).read(scope, input), { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await createPhotoRecognitionService(sql).start(scope, await readOpeningJsonBody(request)), { status: 202, headers: { "cache-control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
