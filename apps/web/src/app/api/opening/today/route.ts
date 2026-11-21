import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";

async function today(request: Request, prepare: boolean): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    if (!date) {
      return Response.json({ error: { code: "VALIDATION", message: "date query required YYYY-MM-DD" } }, { status: 422 });
    }
    const service = getPlanService(sql);
    const plan = prepare
      ? await service.getToday(scope, date, { refreshSuggestions: url.searchParams.get("refresh") === "suggestions" })
      : await service.readToday(scope, date);
    return Response.json(plan);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function GET(request: Request): Promise<Response> {
  return today(request, false);
}

export async function POST(request: Request): Promise<Response> {
  return today(request, true);
}
