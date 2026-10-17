import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { getExamSprintService } from "../../../../../features/opening/exam-sprint/runtime";
import { examSprintResponse } from "../../../../../features/opening/exam-sprint/http";

export const GET = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  return getExamSprintService(sql).export(scope);
}, true);
