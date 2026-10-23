import { cardVariantRequestSchema, uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getCardVariantService, classifyCardVariant, completeCardVariant } from "../../../../../features/opening/cards/card-variant-runtime";
import { examSprintResponse } from "../../../../../features/opening/exam-sprint/http";

export const POST = (request: Request, context: { params: Promise<{ id: string }> }) => examSprintResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const cardId = uuidSchema.parse((await context.params).id);
  const input = cardVariantRequestSchema.parse(await readOpeningJsonBody(request, 8192));
  if (input.action === "classify") {
    await classifyCardVariant(sql, scope, cardId, input.reviewKind);
    return { ok: true };
  }
  if (input.action === "complete") return completeCardVariant(sql, scope, cardId, input.observationId);
  return getCardVariantService(sql).start(scope, cardId, input.action === "retry", request.signal);
});
