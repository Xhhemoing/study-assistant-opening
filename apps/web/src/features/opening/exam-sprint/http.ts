import "server-only";
import { jsonError, mapDomainError } from "../../auth/service";

export async function examSprintResponse(run: () => Promise<unknown>, download = false): Promise<Response> {
  let response: Response;
  try {
    response = Response.json(await run());
    if (download) response.headers.set("Content-Disposition", 'attachment; filename="math-i-exam-sprint.json"');
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
