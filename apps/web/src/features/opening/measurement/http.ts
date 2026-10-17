import "server-only";
import { jsonError, mapDomainError } from "../../auth/service";

/** No trial answers, feedback, or predictions may be cached across accounts. */
export async function measurementResponse(run: () => Promise<unknown>, download = false): Promise<Response> {
  let response: Response;
  try {
    response = Response.json(await run());
    if (download) response.headers.set("Content-Disposition", 'attachment; filename="learning-test.json"');
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
