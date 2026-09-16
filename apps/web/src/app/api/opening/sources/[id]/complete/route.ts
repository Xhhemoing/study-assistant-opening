import {
  jsonError,
  mapDomainError,
} from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";

type Params = { params: Promise<{ id: string }> };

/** materials owns complete — requires prior PUT staging stub. */
export async function POST(
  request: Request,
  context: Params,
): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const source = await createOpeningSourceService(sql).completeUpload(
      principal,
      id,
    );
    return Response.json(source);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
