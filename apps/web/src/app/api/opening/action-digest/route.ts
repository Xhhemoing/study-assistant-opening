import { actionDigestSchema } from "@aistudy/contracts";
import { createOpeningActionDigestDecisionsRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";
import {
  createExtractJobCandidateSource,
  createOpeningActionService,
} from "../../../../features/opening/planning/action-service";
import { getActionDigestOverrides } from "./deps";

/**
 * P04 action-digest projection.
 * Pending candidates: succeeded `extract-study-actions` job results (0051).
 * Accept/reject: durable overlay via migration 0052 decisions repo.
 * Never auto-accept.
 */

function getActionService(sql: import("postgres").Sql) {
  const planService = getPlanService(sql);
  const overrides = getActionDigestOverrides();
  return createOpeningActionService({
    store:
      overrides.store ?? createOpeningActionDigestDecisionsRepository(sql),
    extracted: overrides.extracted ?? createExtractJobCandidateSource(sql),
    planAdapter: {
      async proposeDeltaDraft(input) {
        return planService.proposeDeltaPlan(input.scope, {
          date: input.date,
          taskIds: input.taskIds,
          clientKey: input.clientKey,
        });
      },
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const digest = await getActionService(sql).getDigest(scope);
    return Response.json(actionDigestSchema.parse(digest));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

/**
 * Accept / reject digest candidates (durable overlay).
 * Does not create tasks or accept plans — those stay on T03 / P02 routes.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getActionService(sql).decide(scope, await readOpeningJsonBody(request));
    return Response.json({
      candidate: result.candidate,
      digest: actionDigestSchema.parse(result.digest),
    });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
