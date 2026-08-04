import {
  jsonError,
  mapDomainError,
  requirePrincipal,
  searchForPrincipal,
} from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const rawLimit = url.searchParams.get("limit");
    const result = await searchForPrincipal(
      runtime,
      principal,
      q,
      rawLimit === null ? undefined : Number(rawLimit),
    );
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
