import { restoreBackupForPrincipal } from "../../../../features/library/backup-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const result = await restoreBackupForPrincipal(runtime, principal, await readBody(request));
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}
