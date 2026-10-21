import { courseExamInputSchema, uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { getCourseExamService } from "../../../../../../features/opening/exam-sprint/course-exam-runtime";
import { examSprintResponse } from "../../../../../../features/opening/exam-sprint/http";

type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, context: Context) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  return getCourseExamService(sql).read(scope, uuidSchema.parse((await context.params).id));
});
export const POST = (request: Request, context: Context) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const id = uuidSchema.parse((await context.params).id), input = courseExamInputSchema.parse(await readOpeningJsonBody(request, 8192));
  return getCourseExamService(sql).generate(scope, id, input, request.signal);
});
