import { examSprintCommandSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { getExamSprintService } from "../../../../features/opening/exam-sprint/runtime";
import { examSprintResponse } from "../../../../features/opening/exam-sprint/http";

export const GET = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  return getExamSprintService(sql).read(scope);
});

export const POST = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const command = examSprintCommandSchema.parse(await readOpeningJsonBody(request, 32_768));
  return getExamSprintService(sql).act(scope, command);
});
