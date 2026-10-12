import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import {
  getTutorService,
  requireOpeningScope,
} from "../../../../../../features/opening/runtime";
import { isOpeningDataError } from "../../../../../../features/opening/server/data-services";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const { scope, sql } = await requireOpeningScope(_request);
    const turns = await getTutorService(sql).listTurns(scope, id);
    return Response.json(turns);
  } catch (error) {
    if (isOpeningDataError(error, "conversation")) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.code === "NOT_FOUND" ? 404 : 400 },
      );
    }
    return jsonError(mapDomainError(error));
  }
}
