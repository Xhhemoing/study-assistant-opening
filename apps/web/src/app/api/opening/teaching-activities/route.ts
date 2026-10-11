import { jsonError, mapDomainError } from "../../../../features/auth/service";
import {
  getTeachingActivityService,
  requireOpeningScope,
} from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const rows = await getTeachingActivityService(sql).list(scope);
    return Response.json(rows);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await readOpeningJsonBody(request);
    const created = await getTeachingActivityService(sql).create(scope, body);
    return Response.json(created, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
