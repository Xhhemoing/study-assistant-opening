import { uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { getExamIntegrationService, getExamSprintService } from "../../../../../../features/opening/exam-sprint/runtime";
import { examSprintResponse } from "../../../../../../features/opening/exam-sprint/http";

export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const id = uuidSchema.parse((await context.params).id);
  const integration = await getExamIntegrationService(sql).read(scope);
  return integration.binding?.courseId === id ? { integration, overview: await getExamSprintService(sql).read(scope) } : null;
});
