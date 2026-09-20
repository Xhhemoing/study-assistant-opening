import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    if (!date) {
      return Response.json({ error: { code: "VALIDATION", message: "date query required YYYY-MM-DD" } }, { status: 422 });
    }
    const today = await getPlanService(sql).getToday(scope, date);
    return Response.json(today);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
