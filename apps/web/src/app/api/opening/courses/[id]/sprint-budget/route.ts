import { uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { examSprintResponse } from "../../../../../../features/opening/exam-sprint/http";
import { getSprintBudgetService } from "../../../../../../features/opening/exam-sprint/sprint-budget-runtime";

type Context = { params: Promise<{ id: string }> };
/** Read-only estimate. Unlike getToday, this does not create an automatic draft. */
export const GET = (request: Request, context: Context) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const courseId = uuidSchema.parse((await context.params).id).toLowerCase();
  return getSprintBudgetService(sql).read(scope, courseId);
});
