import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
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
    const body = acceptBodySchema.parse(await request.json());
    const accepted = await createOpeningRetestService(sql).accept(
      scope,
      id,
      body.clientKey,
    );
    // Due entry only — not a claim that P02 calendar scheduling ran.
    return Response.json(
      { ...accepted, scheduled: false, note: "due entry stored; calendar scheduling is P02" },
      { status: 200 },
    );
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
