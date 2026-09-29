import { readOpeningRetestReviewCandidates } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await readOpeningRetestReviewCandidates(sql, scope));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
