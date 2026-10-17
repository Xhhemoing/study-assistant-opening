import { uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { getMeasurementService } from "../../../../../features/opening/measurement/runtime";
import { measurementResponse } from "../../../../../features/opening/measurement/http";

export const GET = (request: Request) => measurementResponse(async () => {
  const { scope, sql } = await requireOpeningScope(request);
  const courseId = uuidSchema.parse(new URL(request.url).searchParams.get("courseId"));
  return getMeasurementService(sql).export(scope, courseId);
}, true);
