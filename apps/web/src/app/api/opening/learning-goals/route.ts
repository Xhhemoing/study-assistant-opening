import { createLearningGoalService } from "../../../../features/opening/courses/learning-goal-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
async function handle(request: Request, write: boolean) {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const repo = createLearningGoalService(sql);
    const course = new URL(request.url).searchParams.get("courseId");
    response = Response.json(write
      ? await repo.create(scope, await readOpeningJsonBody(request, 32_768))
      : await repo.list(scope, course ?? undefined));
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
