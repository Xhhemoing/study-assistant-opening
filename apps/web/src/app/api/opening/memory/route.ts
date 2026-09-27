import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { createOpeningMemoryService } from "../../../../features/opening/memory/memory-service";

/** List memory cards for the session owner (candidates are review-only). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const courseId = new URL(request.url).searchParams.get("courseId");
    const result = await createOpeningMemoryService(sql).listMemory(principal, courseId);
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

/** Propose a candidate or temporary memory (never a silent confirmed fact). */
export async function POST(request: Request): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    const body = (await readOpeningJsonBody(request)) as {
      text: string;
      sourceTurnIds?: string[];
      expiresAt?: string | null;
      courseId?: string | null;
    };
    const item = await createOpeningMemoryService(sql).propose(principal, body);
    return Response.json(item, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
