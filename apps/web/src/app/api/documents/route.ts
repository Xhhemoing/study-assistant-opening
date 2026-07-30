import {
  createDocumentForPrincipal,
  jsonError,
  listDocumentsForPrincipal,
  mapDomainError,
  requirePrincipal,
} from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const documents = await listDocumentsForPrincipal(runtime, principal);
    return Response.json({ documents });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const body = await request.json();
    const doc = await createDocumentForPrincipal(runtime, principal, body);
    return Response.json({ document: doc }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
