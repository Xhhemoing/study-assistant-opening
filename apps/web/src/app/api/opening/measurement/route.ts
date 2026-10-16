import { measurementStartInputSchema, measurementStatusInputSchema, uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { getMeasurementService } from "../../../../features/opening/measurement/runtime";
import { measurementResponse } from "../../../../features/opening/measurement/http";

export const GET = (request: Request) => measurementResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const courseId = uuidSchema.parse(new URL(request.url).searchParams.get("courseId"));
  return getMeasurementService(sql).read(scope, courseId);
});

export const POST = (request: Request) => measurementResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = measurementStartInputSchema.parse(await readOpeningJsonBody(request, 16_384));
  return getMeasurementService(sql).start(scope, input);
});

export const PATCH = (request: Request) => measurementResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const input = measurementStatusInputSchema.parse(await readOpeningJsonBody(request, 16_384));
  return getMeasurementService(sql).setStatus(scope, input);
});
