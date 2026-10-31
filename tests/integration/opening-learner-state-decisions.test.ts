import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOpeningLearnerStateService, readOpeningLearnerState, createOpeningLearningDecisionsRepository,
  explainOpeningLearningDecision, createOpeningPlansRepository, captureOpeningLearnerShadowPredictions,
  createOpeningLearnerShadowPredictionsRepository, createOpeningLearningAttemptRepository,
  createOpeningStudyIntentRepository,
  createOpeningRetestActivityRepository,
} from "@aistudy/database";
import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import { SPAN_SKILL_LABEL, getSpanProblem, type LearningDecisionInput } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { matrixAttemptFixture, matrixRequirement, matrixSkill } from "./opening-matrix-attempt-fixture";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });

async function counts() {
  const { sql, scope } = fixture;
  const [row] = await sql`SELECT
    (SELECT count(*)::int FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId}) AS observations,
    (SELECT count(*)::int FROM opening_learning_eligibility WHERE workspace_id=${scope.workspaceId}) AS eligibility,
    (SELECT count(*)::int FROM opening_learning_decisions WHERE workspace_id=${scope.workspaceId}) AS decisions,
    (SELECT count(*)::int FROM opening_learning_shadow_predictions WHERE workspace_id=${scope.workspaceId}) AS predictions,
    (SELECT count(*)::int FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}) AS counters`;
  return row;
}
async function receipt(targetId: string, overrides: Partial<LearningDecisionInput> = {}): Promise<LearningDecisionInput> {
  const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope);
  return { layer: "session", targetId, stateVersion: state.stateVersion, goalVersion: "goal:1", intentVersion: "intent:1", policyVersion: "selection:1",
    candidates: [{ action: "independent_probe", eligible: true, reasonCodes: ["evidence_gap"], evidenceRefs: [] }], selectedAction: "independent_probe",
    reasonCodes: ["evidence_gap"], evidenceRefs: [], sourceVersions: state.sourceVersions, dataAsOf: state.dataAsOf,
    invalidationConditions: ["state_changed", "source_changed"], ...overrides };
}

describe("LearnerState actual PostgreSQL boundary", () => {
  it("reads live qualification inside a database-enforced read-only snapshot without repairs", async () => {
    const f = await matrixAttemptFixture(fixture);
    const observation = await f.submit(await f.start(), { answer: "[2,3]" });
    await fixture.sql`DELETE FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId} AND head_observation_id=${observation.id}`;
    const before = await counts();
    const result = await fixture.sql.begin("isolation level repeatable read read only", async tx => {
      const state = await readOpeningLearnerState(tx, fixture.scope, { courseId: f.courseId });
      const [transaction] = await tx`SELECT current_setting('transaction_read_only') AS read_only, txid_current_if_assigned() AS assigned`;
      expect(transaction?.read_only).toBe("on");
      expect(transaction?.assigned).toBeNull();
      return state;
    });
    expect(result.features[0]).toMatchObject({ observationId: observation.id, eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" } });
    expect(result.projection).toMatchObject({ mode: "live_read", persistedRows: 0, repairTriggered: false });
    expect(result.display).toMatchObject({ scope: "recorded_requirements", total: 1,
      counts: { independent: 1, hinted: 0, retest: 0, insufficient: 0 } });
    expect(result.skillProfile).toMatchObject({ profileVersion: "rule-profile:1", stateVersion: result.stateVersion,
      scope: { workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.scope.ownerUserId, courseId: f.courseId },
      items: [{ courseId: f.courseId, requirementKey: matrixRequirement, state: "independent",
        observationRefs: [{ observationId: observation.id, sourceIds: expect.any(Array) }] }] });
    expect(await counts()).toEqual(before);
  });

  it("keeps full ordered model features when the display is truncated", async () => {
    const f = await matrixAttemptFixture(fixture);
    for (let i = 0; i < 3; i++) await f.submit(await f.start(), { answer: "unparseable" });
    const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId, limit: 1 });
    expect(state.evidence).toHaveLength(1);
    expect(state.features).toHaveLength(3);
    expect(state.features.map(row => row.attemptedAt)).toEqual(state.features.map(row => row.attemptedAt).sort());
    expect(state.completeness).toMatchObject({ status: "truncated", total: 3, returned: 1 });
    expect(state.display).toMatchObject({ total: 1, counts: { independent: 0, hinted: 0, retest: 0, insufficient: 1 } });
  });

  it("rejects cross-owner and foreign-course scopes", async () => {
    const f = await matrixAttemptFixture(fixture);
    const service = createOpeningLearnerStateService(fixture.sql);
    await expect(service.read({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.read(fixture.otherScope, { courseId: f.courseId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("treats materials without observations as an evidence gap", async () => {
    const f = await learningAttemptFixture(fixture);
    const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
    expect(state.summary).toEqual([]);
    expect(state.completeness.gaps).toContain("no_observation_evidence");
    expect(state.display.total).toBe(0);
  });

  it("uses canonical help and delivered solutions without rewriting original independent qualification", async () => {
    const f = await matrixAttemptFixture(fixture), service = createOpeningLearnerStateService(fixture.sql);
    const first = await f.start();
    await f.help(first, "hinted");
    await f.submit(first);
    expect((await service.read(fixture.scope, { courseId: f.courseId })).display.counts.hinted).toBe(1);
    const next = await f.start(), independent = await f.submit(next);
    const before = await service.read(fixture.scope, { courseId: f.courseId });
    expect(before.display.counts.independent).toBe(1);
    await f.help(next, "revealed");
    const after = await service.read(fixture.scope, { courseId: f.courseId });
    expect(after.display).toMatchObject({ total: 1, counts: { independent: 0, hinted: 0, retest: 1, insufficient: 0 } });
    expect(after.features.find(row => row.observationId === independent.id)?.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes" });
    expect(after.skillProfile.items[0]?.observationRefs[0]?.observationId).toBe(independent.id);
    expect(after.stateVersion).not.toBe(before.stateVersion);
  });

  it("overlays only accepted due tasks for the exact requirement, respecting all queue time floors", async () => {
    const f = await matrixAttemptFixture(fixture), service = createOpeningLearnerStateService(fixture.sql);
    await f.submit(await f.start());
    const activities = createOpeningRetestActivityRepository(fixture.sql), taskId = randomUUID();
    const past = "2000-01-01T00:00:00.000Z", future = "2100-01-01T00:00:00.000Z";
    await fixture.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,due_at,priority,status,version)
      VALUES(${taskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'Retest',15,NULL,1,'pending',1)`;
    const proposed = await activities.createProposed(fixture.scope, { cycleId: randomUUID(), courseId: f.courseId,
      skillLabel: matrixSkill, requirementKey: matrixRequirement, recommendedAt: past });
    const read = () => service.read(fixture.scope, { courseId: f.courseId });
    expect((await read()).display.counts.independent).toBe(1);
    await activities.accept(fixture.scope, proposed.activityId, taskId, past);
    await fixture.sql`UPDATE opening_retest_activities SET requirement_key='other-requirement' WHERE id=${proposed.activityId}`;
    expect((await read()).display.counts.independent).toBe(1);
    await fixture.sql`UPDATE opening_retest_activities SET requirement_key=${matrixRequirement},recommended_at=${future} WHERE id=${proposed.activityId}`;
    expect((await read()).display.counts.independent).toBe(1);
    await fixture.sql`UPDATE opening_retest_activities SET recommended_at=${past},scheduled_start_at=${future} WHERE id=${proposed.activityId}`;
    expect((await read()).display.counts.independent).toBe(1);
    await fixture.sql`UPDATE opening_retest_activities SET scheduled_start_at=NULL,not_before_at=${future} WHERE id=${proposed.activityId}`;
    expect((await read()).display.counts.independent).toBe(1);
    await fixture.sql`UPDATE opening_retest_activities SET not_before_at=NULL,snoozed_until=${future} WHERE id=${proposed.activityId}`;
    expect((await read()).display.counts.independent).toBe(1);
    await fixture.sql`UPDATE opening_retest_activities SET snoozed_until=NULL WHERE id=${proposed.activityId}`;
    await fixture.sql`UPDATE opening_tasks SET not_before=${future} WHERE id=${taskId}`;
    const notDue = await read();
    expect(notDue.display.counts.independent).toBe(1);
    await fixture.sql`UPDATE opening_tasks SET not_before=NULL WHERE id=${taskId}`;
    const beforeCounts = await counts(), due = await read();
    expect(due.display).toMatchObject({ total: 1, counts: { independent: 0, hinted: 0, retest: 1, insufficient: 0 } });
    expect(due.display.requirements[0]).toMatchObject({ requirementKey: matrixRequirement, dueRetest: true });
    expect(due.features[0]?.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes" });
    expect(due.stateVersion).not.toBe(notDue.stateVersion);
    expect(await counts()).toEqual(beforeCounts);
    await fixture.sql`UPDATE opening_tasks SET status='done' WHERE id=${taskId}`;
    expect((await read()).display.counts.independent).toBe(1);
  });
});

describe("immutable decision provenance", () => {
  it("replays identical records and rejects changed candidate intent", async () => {
    const f = await matrixAttemptFixture(fixture);
    const repo = createOpeningLearningDecisionsRepository(fixture.sql), input = await receipt(f.sessionId), key = randomUUID();
    const first = await repo.record(fixture.scope, input, key);
    expect((await repo.record(fixture.scope, input, key)).id).toBe(first.id);
    await expect(repo.record(fixture.scope, { ...input, reasonCodes: ["different"] }, key)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.get(fixture.otherScope, first.id)).toBeNull();
  });

  it("does not leak foreign targets or parents", async () => {
    const f = await matrixAttemptFixture(fixture), repo = createOpeningLearningDecisionsRepository(fixture.sql);
    const input = await receipt(f.sessionId);
    await expect(repo.record(fixture.otherScope, input, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    const parent = await repo.record(fixture.scope, input, randomUUID());
    await expect(repo.record(fixture.scope, { ...input, parentDecisionId: parent.id }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("explains historical reasons read-only and invalidates them after a real new fact", async () => {
    const f = await matrixAttemptFixture(fixture), repo = createOpeningLearningDecisionsRepository(fixture.sql);
    const saved = await repo.record(fixture.scope, await receipt(f.sessionId), randomUUID());
    const before = await counts();
    const first = await fixture.sql.begin("isolation level repeatable read read only", tx => explainOpeningLearningDecision(tx, fixture.scope, saved.id));
    expect(first).toMatchObject({ current: true, invalidationReasons: [] });
    expect(await counts()).toEqual(before);
    await f.submit(await f.start(), { answer: "[2,3]" });
    const after = await repo.explain(fixture.scope, saved.id);
    expect(after).toMatchObject({ current: false, invalidationReasons: ["state_changed", "source_changed"] });
    expect((await repo.get(fixture.scope, saved.id))?.reasonCodes).toEqual(["evidence_gap"]);
  });

  it("marks source revisions stale without erasing the original verified result", async () => {
    const f = await matrixAttemptFixture(fixture);
    await f.submit(await f.start(), { answer: "[2,3]" });
    const repo = createOpeningLearningDecisionsRepository(fixture.sql), saved = await repo.record(fixture.scope, await receipt(f.sessionId), randomUUID());
    await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId} AND workspace_id=${fixture.scope.workspaceId}`;
    const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
    expect(state.features[0]).toMatchObject({ availability: "stale", eligibility: { verifiedCorrect: "yes" } });
    expect(state.completeness.stale).toBe(true);
    expect(state.display.counts.insufficient).toBe(1);
    expect((await repo.explain(fixture.scope, saved.id))?.invalidationReasons).toContain("state_changed");
  });

  it("revalidates session and child activity intent against persisted events rather than caller versions", async () => {
    const f = await matrixAttemptFixture(fixture), repo = createOpeningLearningDecisionsRepository(fixture.sql);
    const intents = createOpeningStudyIntentRepository(fixture.sql);
    const first = await intents.append(fixture.scope, { sessionId: f.sessionId, clientKey: randomUUID(),
      change: { kind: "signal", signal: "confused" } });
    const input = await receipt(f.sessionId, { intentVersion: `${first.id}:v${first.version}`,
      invalidationConditions: ["state_changed", "intent_changed"] });
    const session = await repo.record(fixture.scope, input, randomUUID());
    const activity = await repo.record(fixture.scope, { ...input, layer: "activity", targetId: first.activityId, parentDecisionId: session.id }, randomUUID());
    expect((await repo.explain(fixture.scope, session.id))?.current).toBe(true);
    await intents.append(fixture.scope, { sessionId: f.sessionId, clientKey: randomUUID(), change: { kind: "signal", signal: "too_easy" } });
    const before = await counts();
    for (const saved of [session, activity]) {
      const result = await repo.explain(fixture.scope, saved.id, { goalVersion: input.goalVersion,
        intentVersion: input.intentVersion, policyVersion: input.policyVersion });
      expect(result).toMatchObject({ current: false, invalidationReasons: expect.arrayContaining(["intent_changed"]) });
    }
    expect(await counts()).toEqual(before);
    expect(await repo.explain(fixture.otherScope, activity.id)).toBeNull();
  });

  it("writes a plan receipt atomically for a new PlanDraft", async () => {
    const plans = createOpeningPlansRepository(fixture.sql);
    const draft = await plans.proposePlan(fixture.scope, { date: "2026-10-20", tasks: [], free: [], blocks: [], unscheduledTaskIds: [], clientKey: randomUUID() });
    const [decision] = await createOpeningLearningDecisionsRepository(fixture.sql).list(fixture.scope, { layer: "plan", targetId: draft.id });
    expect(decision).toMatchObject({ targetId: draft.id, layer: "plan", selectedAction: "propose_plan_draft", reasonCodes: ["learner_confirmation_required"] });
    expect(decision?.candidates).toContainEqual(expect.objectContaining({ action: "propose_plan_draft", eligible: true }));
  });
});

describe("pre-answer shadow capture", () => {
  it("captures once on canonical start and never rewrites on replay", async () => {
    const f = await learningAttemptFixture(fixture), key = randomUUID();
    const input = { sessionId: f.sessionId, clientKey: key, problem: { sourceId: f.sourceId, chunkId: f.chunkId, stemSnapshot: "new question", artifactKind: "reference_item" as const } };
    const repo = createOpeningLearningAttemptRepository(fixture.sql);
    const first = await repo.create(fixture.scope, input), replay = await repo.create(fixture.scope, input);
    const rows = await fixture.sql`SELECT * FROM opening_learning_shadow_predictions WHERE attempt_id=${first.id}`;
    expect(first.id).toBe(replay.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.receipt).toMatchObject({ calibrated: false, unavailableReason: "canonical_family_or_requirement_unavailable" });
    expect(new Date(rows[0]!.input_cutoff as Date).getTime()).toBeLessThanOrEqual(new Date(rows[0]!.captured_at as Date).getTime());
  });

  it("captures ordered BKT/PFA inputs before answers and excludes the held-out target family", async () => {
    const f = await learningAttemptFixture(fixture);
    const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId], skillLabel: SPAN_SKILL_LABEL });
    const service = createOpeningAttemptService(fixture.sql);
    const start = (problemId: string) => service.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(),
      spanExercise: { sourceId: f.sourceId, problemId, version: 1 } });
    const submit = (attemptId: string, problemId: string, coefficients: string[], checks: string[]) => {
      const problem = (getSpanProblem(problemId) ?? getSpanReservedProblem(problemId))!;
      return service.submit(fixture.scope, attemptId, { clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients,
        coordinateChecks: checks, equation: { vectors: problem.vectors, target: problem.target } }), outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    };
    const baseline = await start("span-example-2d");
    const baselineObservation = await submit(baseline.id, "span-example-2d", ["3", "-1/2"], ["3", "-1"]);
    const target = await start("span-reserved-transfer");
    const [saved] = await fixture.sql`SELECT * FROM opening_learning_shadow_predictions WHERE attempt_id=${target.id}`;
    expect(saved?.receipt).toMatchObject({ calibrated: false, familySeenBefore: false,
      evidenceObservationIds: [baselineObservation.id], familySplit: "exclude_target_family", timeSplit: "strictly_before_input_cutoff" });
    expect((saved!.receipt as { predictions: unknown[] }).predictions).toHaveLength(3);
    const targetProblem = getSpanReservedProblem("span-reserved-transfer")!;
    const targetObservation = await service.submit(fixture.scope, target.id, { clientKey: randomUUID(),
      answer: JSON.stringify({ membership: "not_in_span", noSolutionWitness: ["1", "2", "0"], equation: { vectors: targetProblem.vectors, target: targetProblem.target } }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    const state = await createOpeningLearnerStateService(fixture.sql).read(fixture.scope, { courseId: f.courseId });
    const projected = state.features.find(row => row.observationId === targetObservation.id)!;
    expect(projected.views).toEqual(expect.arrayContaining(["independent", "transfer"]));
    expect(projected.transfer.knowledgeComponents).toEqual(["span:vector-equation"]);
    expect(projected.transfer.reasonCodes).toContain("transfer_kc_unverified:geometry:line-equation");
    const [timing] = await fixture.sql`SELECT p.input_cutoff,a.submitted_at FROM opening_learning_shadow_predictions p
      JOIN opening_learning_attempts a ON a.id=p.attempt_id WHERE a.id=${target.id}`;
    expect(new Date(timing!.input_cutoff as Date).getTime()).toBeLessThan(new Date(timing!.submitted_at as Date).getTime());
    const report = await createOpeningLearnerShadowPredictionsRepository(fixture.sql).compare(fixture.scope);
    expect(report.count).toBeGreaterThanOrEqual(2);
  });

  it("refuses to backfill missing forecasts after an answer", async () => {
    const f = await matrixAttemptFixture(fixture), attempt = await f.start();
    await f.submit(attempt);
    await fixture.sql`DELETE FROM opening_learning_shadow_predictions WHERE attempt_id=${attempt.id}`;
    await expect(fixture.sql.begin(tx => captureOpeningLearnerShadowPredictions(tx, fixture.scope, attempt.id))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("compares only stored forecasts and remains a read-only shadow service", async () => {
    const before = await counts();
    const result = await createOpeningLearnerShadowPredictionsRepository(fixture.sql).compare(fixture.scope);
    expect(result).toMatchObject({ mode: "shadow", calibrated: false });
    expect(await counts()).toEqual(before);
    expect((await createOpeningLearnerShadowPredictionsRepository(fixture.sql).compare(fixture.otherScope)).count).toBe(0);
  });
});
