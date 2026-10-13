import { learningResumeSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import {
  getTeachingResumeService,
  requireOpeningScope,
} from "../../../../../../../features/opening/runtime";
import { teachingLoopApiDenied } from "../../../../../../../server/opening-config";

/**
 * GET teaching activity LearningResume (V2-14).
 * Auth + ownership; returns full package (sanitized). Not ConversationResume.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    // PR-H: server re-authorizes; a hidden UI is not the gate.
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) return denied;
    const { id } = await context.params;
    const resume = await getTeachingResumeService(sql).getResume(scope, id);
    const body = learningResumeSchema.parse(resume);
    const response = Response.json(body);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
