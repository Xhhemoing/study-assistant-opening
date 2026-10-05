import { z } from "zod";
import { readOpeningSourceContent } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
const parameters = z.object({ version: z.coerce.number().int().nonnegative().optional(), page: z.coerce.number().int().positive().optional() });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const id = z.string().uuid().parse((await context.params).id);
    const query = new URL(request.url).searchParams;
    const input = parameters.parse({ version: query.get("version") ?? undefined, page: query.get("page") ?? undefined });
    return Response.json(await readOpeningSourceContent(sql, scope, id, input), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
