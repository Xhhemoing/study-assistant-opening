import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createOpeningRetestService } from "../../../../../../features/opening/learning/retest-service";

const acceptBodySchema = z
  .object({
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = acceptBodySchema.parse(await readOpeningJsonBody(request));
    const accepted = await createOpeningRetestService(sql).accept(
      scope,
      id,
      body.clientKey,
    );
    // Due entry is stored on the task snapshot. P02 cannot place it on a calendar.
    return Response.json(
      { ...accepted, scheduled: false },
      { status: 200 },
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
