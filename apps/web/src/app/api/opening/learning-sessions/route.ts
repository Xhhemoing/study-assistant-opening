import { learningSessionCreateInputSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import {
  getObservationService,
  requireOpeningScope,
} from "../../../../features/opening/runtime";

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = learningSessionCreateInputSchema.parse(await request.json());
    const created = await getObservationService(sql).createLearningSession(
      scope,
      body,
    );
    return Response.json(created, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
