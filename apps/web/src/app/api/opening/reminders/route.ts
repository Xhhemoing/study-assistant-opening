import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { createOpeningReminderRepository } from "@aistudy/database";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { createOpeningReminderService } from "../../../../features/opening/planning/reminder-service";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await createOpeningReminderService(createOpeningReminderRepository(sql)).list(scope);
    return Response.json(body);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const reminders = await createOpeningReminderService(createOpeningReminderRepository(sql))
      .enqueue(scope, await readOpeningJsonBody(request));
    const created = reminders.some((item) => item.created === true);
    return Response.json({
      reminders: reminders.map(({ created: _created, ...reminder }) => reminder),
    }, { status: created ? 201 : 200 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
