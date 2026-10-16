import { measurementNextInputSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getMeasurementService } from "../../../../../features/opening/measurement/runtime";
import { measurementResponse } from "../../../../../features/opening/measurement/http";

export const POST = (request: Request) => measurementResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = measurementNextInputSchema.parse(await readOpeningJsonBody(request, 16_384));
  return getMeasurementService(sql).next(scope, input);
});
