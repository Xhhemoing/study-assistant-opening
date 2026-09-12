import {
  gradeReviewForPrincipal,
  listReviewQueueForPrincipal,
} from "../../../features/review/review-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const mode = new URL(request.url).searchParams.get("mode");
    const result = await listReviewQueueForPrincipal(runtime, principal, mode ? { mode } : {});
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const result = await gradeReviewForPrincipal(runtime, principal, await request.json());
    return Response.json(result, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
