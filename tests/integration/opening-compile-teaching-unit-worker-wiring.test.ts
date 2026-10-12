/**
 * PR-D: completed-key replay through the REAL worker wiring
 * (createCompileTeachingUnitWorkerDeps, as constructed by apps/worker main):
 * the real loadReplayedResult → teachingActivities.get, real publish, real
 * ledger. Replay never calls the provider and returns the existing result.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository,
  createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository,
} from "@aistudy/database";
import type { OpeningJobRecord } from "@aistudy/database";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.reset(); });
afterAll(async () => { await f?.close(); });

async function ledger() {
  const rows = await f.sql`
    SELECT count(*)::int AS rows,
      COALESCE(sum(amount_cents) FILTER (WHERE state='completed'),0)::int AS used,
      COALESCE(sum(amount_cents) FILTER (WHERE state='reserved'),0)::int AS reserved,
      COALESCE(sum(pending_reconcile_cents),0)::int AS pending,
      max(result_ref) AS result_ref
    FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  return rows[0] as unknown as { rows: number; used: number; reserved: number; pending: number; result_ref: string | null };
}

describe("compile-teaching-unit worker wiring: completed replay", () => {
  it("loads the persisted activity via the production loader; provider not called again, no new charge", async () => {
    const deps = createCompileTeachingUnitWorkerDeps(f.sql, {
      budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
      chunks: createOpeningSourceChunksRepository(f.sql),
      privacy: createOpeningPrivacyRepository(f.sql),
    });
    // Observe (not replace) the production provider and loader.
    const providerSpy = vi.spyOn(deps.provider!, "complete");
    const loaderSpy = vi.spyOn(deps, "loadReplayedResult");
    const publishSpy = vi.spyOn(deps, "publishActivitySpec");
    const run = createCompileTeachingUnitHandler(deps);

    const activities = createOpeningTeachingActivitiesRepository(f.sql);
    const activity = await activities.create(f.scope, {
      clientKey: `wiring-${randomUUID()}`, intentKind: "topic", intentSummary: "wiring replay", createIntent: { t: 1 },
    });
    await activities.setGenerateStatus(f.scope, activity.id, "queued");
    const unit = await createOpeningTeachingContentRepository(f.sql).createUnit(f.scope, { title: "unit", blocks: [{ id: randomUUID(), type: "text", content: { markdown: "seed" } }] });
    const job: OpeningJobRecord = {
      id: randomUUID(), workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId,
      key: "k", kind: "compile-teaching-unit", payload: {}, result: null, state: "running", privacyEpoch: 0,
    };
    const payload = { mode: "generate" as const, activityId: activity.id, teachingUnitId: unit.id, expectedContentVersion: 0, clientKey: "client-key-01", sourceIds: [] };

    await run(job, payload);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const persisted = await activities.get(f.scope, activity.id);
    expect(persisted?.generateStatus).toBe("needs_check");
    const before = await ledger();
    expect(before).toMatchObject({ rows: 1, reserved: 0, pending: 0, result_ref: `teaching_activity:${activity.id}` });

    const replay = await run(job, payload);
    expect(replay).toEqual({ replayed: true, activityId: activity.id, generateStatus: "needs_check" });
    expect(loaderSpy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: f.scope.workspaceId }), `teaching_activity:${activity.id}`);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const after = await ledger();
    expect(after).toEqual(before);
    expect((await activities.get(f.scope, activity.id))?.generateStatus).toBe("needs_check");

    if (process.env.BUDGET_MATRIX_OUT) {
      appendFileSync(process.env.BUDGET_MATRIX_OUT, `${JSON.stringify({ case: "compile-teaching-unit replay via worker wiring", logicalOps: 2, providerCalls: providerSpy.mock.calls.length, used: after.used, reserved: after.reserved, pending: after.pending, reconcileEvents: "-", outcome: "production loader returned needs_check; no provider/publish" })}\n`);
    }
  });

  it("production loader is scope-bound and rejects foreign refs", async () => {
    const deps = createCompileTeachingUnitWorkerDeps(f.sql, {
      budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
      chunks: createOpeningSourceChunksRepository(f.sql),
      privacy: createOpeningPrivacyRepository(f.sql),
    });
    const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
      clientKey: `wiring-${randomUUID()}`, intentKind: "topic", intentSummary: "scope", createIntent: { t: 2 },
    });
    expect(await deps.loadReplayedResult(f.scope, `teaching_activity:${activity.id}`)).toMatchObject({ activityId: activity.id });
    expect(await deps.loadReplayedResult(f.otherScope, `teaching_activity:${activity.id}`)).toBeNull();
    expect(await deps.loadReplayedResult(f.scope, `opening_turn:${activity.id}`)).toBeNull();
  });
});
