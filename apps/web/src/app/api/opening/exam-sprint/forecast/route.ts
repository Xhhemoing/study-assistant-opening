import { examPaperInputSchema } from "@aistudy/contracts";
import { z } from "zod";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getExamForecastService } from "../../../../../features/opening/exam-sprint/runtime";
import { examSprintResponse } from "../../../../../features/opening/exam-sprint/http";

export const GET = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const teacher = z.string().trim().min(1).max(100).nullable().parse(new URL(request.url).searchParams.get("teacher"));
  return getExamForecastService(sql).read(scope, teacher);
});
export const POST = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = examPaperInputSchema.parse(await readOpeningJsonBody(request, 32_768));
  return getExamForecastService(sql).record(scope, input);
});
