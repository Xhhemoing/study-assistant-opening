import { examBindInputSchema, examSourceMappingInputSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getExamIntegrationService } from "../../../../../features/opening/exam-sprint/runtime";
import { examSprintResponse } from "../../../../../features/opening/exam-sprint/http";

export const GET = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  return getExamIntegrationService(sql).read(scope);
});
export const POST = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = examBindInputSchema.parse(await readOpeningJsonBody(request, 32_768));
  return getExamIntegrationService(sql).bind(scope, input);
});
export const PATCH = (request: Request) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = examSourceMappingInputSchema.parse(await readOpeningJsonBody(request, 4096));
  return getExamIntegrationService(sql).mapSource(scope, input);
});
