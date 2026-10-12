import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { getReminderService } from "../../../../features/opening/server/data-services";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await getReminderService(sql).list(scope);
    return Response.json(body);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const reminders = await getReminderService(sql)
      .enqueue(scope, await readOpeningJsonBody(request));
    const created = reminders.some((item) => item.created === true);
    return Response.json({
      reminders: reminders.map(({ created: _created, ...reminder }) => reminder),
    }, { status: created ? 201 : 200 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
