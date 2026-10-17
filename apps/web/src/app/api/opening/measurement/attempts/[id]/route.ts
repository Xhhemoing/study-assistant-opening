import { measurementActionInputSchema, uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { getMeasurementService } from "../../../../../../features/opening/measurement/runtime";
import { measurementResponse } from "../../../../../../features/opening/measurement/http";

export const POST = (request: Request, context: { params: Promise<{ id: string }> }) => measurementResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const id = uuidSchema.parse((await context.params).id);
  const input = measurementActionInputSchema.parse(await readOpeningJsonBody(request, 16_384));
  return getMeasurementService(sql).act(scope, id, input);
});
