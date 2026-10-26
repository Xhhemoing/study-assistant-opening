import { createAssistantProposalService } from "../../../../features/opening/assistant/proposal-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { z } from "zod";
import { pendingAssistantProposalsQuerySchema } from "@aistudy/contracts";

const pendingQuery = pendingAssistantProposalsQuerySchema.extend({ status: z.literal("draft") });

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const service = createAssistantProposalService(sql);
    const params = new URL(request.url).searchParams;
    if (params.size) {
      const { status: _status, ...query } = pendingQuery.parse(Object.fromEntries(params));
      return Response.json(await service.listPending(scope, query), { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ proposals: await service.list(scope) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = await readOpeningJsonBody(request);
    return Response.json({ proposal: await createAssistantProposalService(sql).propose(scope, input) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
