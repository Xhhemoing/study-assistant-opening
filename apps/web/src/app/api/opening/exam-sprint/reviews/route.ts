import { examWorkReviewInputSchema, uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getExamReviewService } from "../../../../../features/opening/exam-sprint/runtime";
import { examSprintResponse } from "../../../../../features/opening/exam-sprint/http";

export const GET = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const id = uuidSchema.parse(new URL(request.url).searchParams.get("id"));
  return getExamReviewService(sql).read(scope, id);
});
export const POST = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = examWorkReviewInputSchema.parse(await readOpeningJsonBody(request, 32_768));
  return getExamReviewService(sql).review(scope, input);
});
