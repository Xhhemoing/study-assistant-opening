import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { readOpeningPlanFeedbackSummary } from "./opening-plan-feedback";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const from = new Date("2026-10-09T12:00:00Z"), until = new Date("2026-10-16T12:00:00Z");

it("keeps action counts separate from skip/defer reason coverage and distinguishes missing/non-disclosure", async () => {
  const query = vi.fn().mockResolvedValue([
    { action: "done", reason: "too_easy", n: 2 },
    { action: "skipped", reason: "time_short", n: 2 },
    { action: "deferred", reason: null, n: 1 },
    { action: "deferred", reason: "prefer_not_say", n: 1 },
    { action: "resumed", reason: null, n: 3 },
  ]);
  const result = await readOpeningPlanFeedbackSummary(query as unknown as Sql, scope, from, until);
  expect(result.actions).toEqual({ done: 2, skipped: 2, deferred: 2, resumed: 3 });
  expect(result.reasons).toEqual({ eligible: 4, supplied: 2, missing: 1, declined: 1, coverage: 0.5,
    counts: { time_short: 2, too_hard: 0, too_easy: 0, not_relevant: 0, other: 0 } });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]!.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId, from, until]);
});

it("returns null for an empty denominator rather than an invented zero rate", async () => {
  const query = vi.fn().mockResolvedValue([]);
  expect(await readOpeningPlanFeedbackSummary(query as unknown as Sql, scope, from, until))
    .toMatchObject({ reasons: { eligible: 0, coverage: null }, historicalActions: "unknown" });
});
