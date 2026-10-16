import "server-only";
import type { Sql } from "postgres";
import { calendarDateSchema, coachPlanAcceptInputSchema, coachPlanAcceptResultSchema, coachPlanUndoInputSchema, type Scope } from "@aistudy/contracts";
import { loadFeatureSwitches } from "@aistudy/config";
import { resolveLocalDayBounds } from "@aistudy/domain";
import { acceptOpeningPlan, mapOpeningPlanDraft, readOpeningCoachAcceptance, undoOpeningCoachPlan } from "@aistudy/database";
import { ApiError } from "../../auth/service";

export function createOpeningCoachPlanService(sql: Sql, options: { now?: () => Date; enabled?: boolean } = {}) {
  const now = options.now ?? (() => new Date());
  const assertEnabled = () => {
    if (!(options.enabled ?? loadFeatureSwitches(process.env).adaptivePlanning)) throw new ApiError("NOT_FOUND", "Not found", 404);
  };
  return {
    async accept(scope: Scope, raw: unknown) {
      assertEnabled();
      const input = coachPlanAcceptInputSchema.parse(raw), at = now();
      const accepted = await acceptOpeningPlan(sql, scope, { draftId: input.draftId, expectedBaseVersion: 0, clientKey: input.clientKey }, at,
        { source: "coach", expectedDraftVersion: input.expectedDraftVersion });
      const draft = mapOpeningPlanDraft(accepted);
      const acceptance = await readOpeningCoachAcceptance(sql, scope, draft.date, at, input.clientKey);
      return coachPlanAcceptResultSchema.parse({ draft, acceptance });
    },
    async undo(scope: Scope, raw: unknown) {
      assertEnabled();
      return undoOpeningCoachPlan(sql, scope, coachPlanUndoInputSchema.parse(raw), now());
    },
    async summary(scope: Scope, rawDate: unknown) {
      assertEnabled();
      const date = calendarDateSchema.parse(rawDate);
      resolveLocalDayBounds(date, "UTC");
      return readOpeningCoachAcceptance(sql, scope, date, now());
    },
  };
}
