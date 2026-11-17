import { z } from "zod";
import { teachingExampleRequestSchema, teachingExampleTargetSchema, teachingExampleStatusSchema, uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createTeachingExampleService } from "../../../../../features/opening/teaching/teaching-example-service";
import { teachingLoopApiDenied } from "../../../../../server/opening-config";

/** Explicit only. Status/estimate GETs never enqueue, reconcile or call a provider. */
export async function POST(request: Request) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId); if (denied) return denied;
    const body = teachingExampleRequestSchema.parse(await readOpeningJsonBody(request));
    const status = await createTeachingExampleService(sql).request(scope, body);
    return Response.json(teachingExampleStatusSchema.parse(status), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
export async function GET(request: Request) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId); if (denied) return denied;
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const service = createTeachingExampleService(sql);
    if (query.operationId) {
      const input = z.object({ operationId: uuidSchema }).strict().parse(query);
      return Response.json(await service.read(scope, input.operationId), { headers: { "Cache-Control": "no-store" } });
    }
    if (query.clientKey) {
      const input = z.object({ clientKey: z.string().min(8).max(120) }).strict().parse(query);
      return Response.json({ operation: await service.find(scope, input.clientKey) }, { headers: { "Cache-Control": "no-store" } });
    }
    const lookup = query.lookup === "target";
    const inputQuery = lookup ? Object.fromEntries(Object.entries(query).filter(([key]) => key !== "lookup")) : query;
    const input = z.object({ activityId: uuidSchema, documentId: uuidSchema, blockId: uuidSchema,
      revisionNumber: z.coerce.number().int().positive(), contentVersion: z.coerce.number().int().positive() }).strict().parse(inputQuery);
    if (lookup) return Response.json({ operation: await service.findTarget(scope, teachingExampleTargetSchema.parse(input)) }, { headers: { "Cache-Control": "no-store" } });
    return Response.json(await service.estimate(scope, teachingExampleTargetSchema.parse(input)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
