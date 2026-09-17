import { createOpeningCandidateRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

/** Pending assistant candidates for the current owner only (M01/P02 consume them later). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const candidates = createOpeningCandidateRepository(sql).listPending(scope);
    return Response.json(await candidates);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
