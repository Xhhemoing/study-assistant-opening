import {
  jsonError,
  mapDomainError,
} from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../../features/opening/sources/source-service";

type Params = { params: Promise<{ id: string }> };

/** materials owns local staging PUT (not real S3). */
export async function PUT(
  request: Request,
  context: Params,
): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const buffer = new Uint8Array(await request.arrayBuffer());
    await createOpeningSourceService(sql).putStaging(
      principal,
      id,
      buffer,
      request.headers.get("content-type"),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
