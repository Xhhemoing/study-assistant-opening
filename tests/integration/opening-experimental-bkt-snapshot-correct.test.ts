import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { compareLearnerShadow, predictLearnerShadow, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { createOpeningExperimentalBktSnapshotRepository, openingExperimentalBktHeadsQuery,
  type ExperimentalBktSnapshotInput } from "../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

// Additive coverage for verified_correct=yes, not a copy of the frozen ten tests.
// Real PG repositories produce scores and qualification; only fixture clocks are
// synthetic. Current effective-head reads are NOT historical reconstruction.
let fixture: OpeningFixture;
const cutoff = "2026-11-10T12:00:00.000Z";
const correctCatalogue = "span-reserved-20261021-q02";
const siblingCatalogue = "span-reserved-generated-teaching-consistent-3d-1729-0";
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });

async function seed() {
  const { sql, scope } = fixture;
  const rows = backupRows(sql, scope), sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId},${scope.workspaceId},'BKT correct companion',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const start = (problemId: string) => attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(),
    spanExercise: { sourceId, problemId, version: 1 } });
  const target = await start("span-example-2d");
  const heads: Array<{ attempt: LearningAttempt; observation: LearningObservation; submitted: string; recorded: string }> = [];
  // Hand-calculated answers, not the scoring solver as the test oracle:
  // q02: -3*(1,2,-1)+(2,-1,3)=(-1,-7,6).
  // generated consistent-3d/1729/0: -5*(1,2,1)+0*(0,1,2)=(-5,-10,-5).
  for (const [index, [catalogue, coefficients, outcome]] of [
    [correctCatalogue, ["-3", "1"], "correct"],
    [siblingCatalogue, ["-5", "0"], "correct"],
    ["span-independent-3d", ["99", "99"], "incorrect"],
  ].entries()) {
    const attempt = await start(catalogue as string), problem = attempt.spanExercise!;
    const observation = await learning.insertObservation(scope, { sessionId: session.id, courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients,
        equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: problem.target }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    expect(observation).toMatchObject({ outcome, verdictSource: "deterministic", assistance: "independent",
      serverEvaluation: { decision: outcome, evaluatorVersion: "span-exact-v1" } });
    if (outcome === "correct") expect(observation.serverEvaluation).toMatchObject({ coreEvidenceComplete: true,
      skills: { equation: "correct", coefficients: "correct", allCoordinates: "correct" } });
    heads.push({ attempt, observation, submitted: `2026-11-10T10:0${index}:00.000Z`, recorded: `2026-11-10T10:0${index}:01.000Z` });
  }
  await sql`UPDATE opening_learning_item_versions SET created_at='2026-11-10T08:00:00Z' WHERE course_id=${courseId}`;
  await sql`UPDATE opening_learning_attempts SET started_at='2026-11-10T09:00:00Z' WHERE course_id=${courseId}`;
  for (const head of heads) {
    await sql`UPDATE opening_learning_attempts SET submitted_at=${head.submitted} WHERE id=${head.attempt.id}`;
    await sql`UPDATE opening_learning_observations SET started_at='2026-11-10T09:00:00Z',
      submitted_at=${head.submitted},recorded_at=${head.recorded} WHERE id=${head.observation.id}`;
  }
  // Real production evaluator owns qualification; no direct eligibility writes.
  await sql.begin(tx => refreshOpeningLearningEligibility(tx, scope, heads.map(row => row.observation.id)));
  const input: ExperimentalBktSnapshotInput = { courseId, requirementKey: SPAN_REQUIREMENT_KEY,
    problemId: target.problemId!, itemVersionId: target.itemVersionId!, cutoff };
  const read = (patch: Partial<ExperimentalBktSnapshotInput> = {}) =>
    createOpeningExperimentalBktSnapshotRepository(sql).read(scope, { ...input, ...patch });
  return { sql, scope, courseId, sourceId, target, heads, input, read };
}
type Seed = Awaited<ReturnType<typeof seed>>;
async function positive(f: Seed) {
  const result = await f.read();
  console.info("BKT_CORRECT_POSITIVE", JSON.stringify({ status: result.status, excluded: result.excluded,
    heads: result.features.map(row => ({ id: row.observationId, outcome: row.outcome, verified: row.eligibility.verifiedCorrect })) }));
  expect(result.status, JSON.stringify(result)).toBe("available");
  expect(result.excluded).toEqual({});
  expect(result.features.map(row => row.observationId)).toEqual(f.heads.map(row => row.observation.id));
  expect(result.features.map(row => row.outcome)).toEqual(["correct", "correct", "incorrect"]);
  expect(result.features.map(row => row.eligibility.verifiedCorrect)).toEqual(["yes", "yes", "no"]);
  expect(result.observationHeads.map(row => row.verifiedCorrect)).toEqual(["yes", "yes", "no"]);
  expect(result.families.map(row => row.familyId)).toEqual(["span:consistent-3d", "span:consistent-3d", "span:inconsistent-3d"]);
  return result;
}

describe("card 1 — actual deterministic correct qualification", () => {
  it("admits two independent correct heads and the independent incorrect positive control from real SQL", async () => {
    const f = await seed();
    await f.sql.begin("isolation level repeatable read read only", async tx => {
      const heads = await openingExperimentalBktHeadsQuery(tx, f.scope, f.input);
      expect(heads).toHaveLength(3);
      expect(heads.map(row => row.verified_correct)).toEqual(["yes", "yes", "no"]);
      console.info("BKT_CORRECT_QUALIFICATION", JSON.stringify(heads.map(row => ({ id: row.id,
        head_revision: row.head_revision, input_revision: row.input_revision, independent: row.independent_attempt,
        verified: row.verified_correct, usable: row.usable_for_current_version, reasons: row.reason_codes }))));
      for (const row of heads) {
        expect(row).toMatchObject({ verdict_source: "deterministic", independent_attempt: "yes",
          usable_for_current_version: "yes", item_current: true, sources_current: true });
        expect(row.reason_codes).toContain(row.verified_correct === "yes" ? "deterministic_correct" : "deterministic_incorrect");
      }
    });
    await positive(f);
  });
});


describe("card 2 — correct-path exclusions keep a real unaffected control", () => {
  it("holds out either correct identity's entire family but keeps incorrect evidence, and denies foreign scope", async () => {
    const f = await seed();
    await positive(f);
    for (const excludedId of [f.heads[0]!.attempt.problemId!, f.heads[0]!.observation.id]) {
      const result = await f.read({ excludedProblemIds: [excludedId] });
      expect(result.status).toBe("available");
      expect(result.features.map(row => row.observationId)).toEqual([f.heads[2]!.observation.id]);
      expect(result.features[0]!.eligibility.verifiedCorrect).toBe("no");
      expect(result.excluded).toEqual({ held_out_or_target_family: 2 });
    }
    const repo = createOpeningExperimentalBktSnapshotRepository(f.sql);
    for (const scope of [fixture.otherScope, { ...f.scope, ownerUserId: fixture.otherScope.ownerUserId },
      { ...f.scope, workspaceId: fixture.otherScope.workspaceId }]) {
      expect(await repo.read(scope, { ...f.input, excludedProblemIds: [f.heads[0]!.observation.id] }))
        .toMatchObject({ status: "not_available", features: [], observationHeads: [] });
    }
    expect(await f.read({ requirementKey: "other:requirement" })).toMatchObject({ status: "not_available", features: [] });
    expect(await f.read({ courseId: randomUUID() })).toMatchObject({ status: "not_available", features: [] });
    await positive(f);
  });

  it("requires both correct-head clocks strictly before cutoff and preserves correct plus incorrect controls", async () => {
    const f = await seed();
    await positive(f);
    const bad = f.heads[0]!, remaining = f.heads.slice(1).map(row => row.observation.id);
    for (const [submitted, recorded] of [[bad.submitted, cutoff], [cutoff, cutoff],
      ["2026-11-10T13:00:00.000Z", "2026-11-10T13:01:00.000Z"], [bad.recorded, bad.submitted]]) {
      await f.sql`UPDATE opening_learning_attempts SET submitted_at=${submitted!} WHERE id=${bad.attempt.id}`;
      await f.sql`UPDATE opening_learning_observations SET submitted_at=${submitted!},recorded_at=${recorded!}
        WHERE id=${bad.observation.id}`;
      const result = await f.read();
      expect(result.status).toBe("available");
      expect(result.features.map(row => row.observationId)).toEqual(remaining);
      expect(result.features.map(row => row.eligibility.verifiedCorrect)).toEqual(["yes", "no"]);
      expect(result.excluded).toEqual({ dual_time_unavailable: 1 });
    }
    await f.sql`UPDATE opening_learning_attempts SET submitted_at=${bad.submitted} WHERE id=${bad.attempt.id}`;
    await f.sql`UPDATE opening_learning_observations SET submitted_at=${bad.submitted},recorded_at=${bad.recorded}
      WHERE id=${bad.observation.id}`;
    await positive(f);
  });

  it("rejects correct heads carrying AI grading payloads without leaking them or losing the C/I controls", async () => {
    const f = await seed();
    await positive(f);
    const bad = f.heads[0]!, marker = "PRIVATE_SCORE_PAYLOAD_BKT_CORRECT_7d035";
    const [stored] = await f.sql`SELECT submitted_intent FROM opening_learning_observations WHERE id=${bad.observation.id}`;
    for (const mode of ["evaluation", "intent"] as const) {
      if (mode === "evaluation") await f.sql`UPDATE opening_learning_observations SET
        ai_evaluation=${f.sql.json({ score: 1, outcome: "correct", explanation: marker })} WHERE id=${bad.observation.id}`;
      else await f.sql`UPDATE opening_learning_observations SET submitted_intent=
        COALESCE(submitted_intent,'{}'::jsonb) || ${f.sql.json({ aiGrading: { score: 1, outcome: "correct", explanation: marker } })}
        WHERE id=${bad.observation.id}`;
      const result = await f.read();
      expect(result.status).toBe("available");
      expect(result.features.map(row => row.observationId)).toEqual(f.heads.slice(1).map(row => row.observation.id));
      expect(result.features.map(row => row.eligibility.verifiedCorrect)).toEqual(["yes", "no"]);
      expect(result.excluded).toEqual({ non_deterministic_or_ai: 1 });
      const rows = await f.sql.begin("isolation level repeatable read read only", tx => openingExperimentalBktHeadsQuery(tx, f.scope, f.input));
      expect(rows.find(row => row.id === bad.observation.id)).toMatchObject({ has_ai: true, verified_correct: "yes" });
      expect(JSON.stringify({ result, rows })).not.toContain(marker);
      for (const row of rows) for (const key of ["answer", "stem_snapshot", "evaluation_spec", "ai_evaluation", "server_evaluation", "submitted_intent", "text"]) {
        expect(row).not.toHaveProperty(key);
      }
      await f.sql`UPDATE opening_learning_observations SET ai_evaluation=NULL,
        submitted_intent=${f.sql.json(stored!.submitted_intent)} WHERE id=${bad.observation.id}`;
      await positive(f);
    }
  });
});


describe("card 3 — qualified C/I enters the actual unfitted repository BKT", () => {
  it("replays real C/C/I with an independent Bayes oracle, validates parameters, and leaves persisted state unchanged", async () => {
    const f = await seed();
    const baseline = await positive(f);
    const state = () => f.sql`SELECT jsonb_build_object(
      'workspace',to_jsonb(w),
      'history',(SELECT jsonb_agg(to_jsonb(h)) FROM opening_workspace_history_revisions h WHERE h.workspace_id=w.id),
      'observations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM opening_learning_observations o WHERE o.workspace_id=w.id),
      'qualification',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.root_observation_id) FROM opening_learning_eligibility p WHERE p.workspace_id=w.id),
      'predictions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.attempt_id) FROM opening_learning_shadow_predictions p WHERE p.workspace_id=w.id),
      'decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM opening_learning_decisions d WHERE d.workspace_id=w.id)
      ) AS state FROM workspaces w WHERE w.id=${f.scope.workspaceId}`;
    const before = await state();
    const modes: string[] = [];
    let violation: string | undefined;
    // Every call goes to the actual postgres.js driver. No row or transaction fake.
    const observed = new Proxy(f.sql, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return (mode: string, callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(mode, async tx => {
          modes.push(mode);
          const [settings] = await tx`SELECT current_setting('transaction_read_only') AS ro,
            current_setting('transaction_isolation') AS isolation`;
          expect(settings).toEqual({ ro: "on", isolation: "repeatable read" });
          try {
            await tx.savepoint(async save => { await save`UPDATE workspaces SET privacy_epoch=privacy_epoch WHERE id=${f.scope.workspaceId}`; });
          } catch (error) { violation = (error as { code?: string }).code; }
          expect(violation).toBe("25006");
          return callback(tx);
        });
      },
    });
    const snapshot = await createOpeningExperimentalBktSnapshotRepository(observed).read(f.scope, f.input);
    expect(snapshot.features).toEqual(baseline.features);
    expect(modes).toEqual(["isolation level repeatable read read only"]);
    const request = { features: snapshot.features, courseId: f.courseId, requirementKey: SPAN_REQUIREMENT_KEY,
      cutoff, excludedProblemIds: [] as string[] };
    const originalRequest = structuredClone(request);
    const result = predictLearnerShadow(request);
    const bkt = result.predictions.find(row => row.modelId === "classical-bkt")!;
    expect(result.evidenceObservationIds).toEqual(f.heads.map(row => row.observation.id));
    expect([result.success, result.failure]).toEqual([2, 1]);
    expect(bkt).toMatchObject({ modelVersion: "1", calibrated: false,
      parameters: { initialKnowledge: 0.2, learning: 0.1, guess: 0.25, slip: 0.1 } });
    // Hand Bayes C,C,I: final transitioned knowledge 191/434;
    // next-answer correctness (191/434)*.9+(243/434)*.25=4653/8680.
    expect(bkt.probability).toBeCloseTo(4653 / 8680, 14);
    const ci = predictLearnerShadow({ ...request, features: [snapshot.features[0]!, snapshot.features[2]!] });
    expect([ci.success, ci.failure]).toEqual([1, 1]);
    expect(ci.predictions.find(row => row.modelId === "classical-bkt")!.probability).toBeCloseTo(2421 / 6200, 14);
    const correctOnly = predictLearnerShadow({ ...request, features: snapshot.features.slice(0, 2) });
    expect(correctOnly.predictions.find(row => row.modelId === "classical-bkt")!.probability).toBeCloseTo(783 / 1000, 14);
    expect(bkt.probability).toBeLessThan(correctOnly.predictions[0]!.probability);
    expect(predictLearnerShadow({ ...request, features: [...snapshot.features].reverse() })).toEqual(result);
    const replay = await f.read();
    expect(replay.features).toEqual(snapshot.features);
    expect(predictLearnerShadow({ ...request, features: replay.features })).toEqual(result);
    expect(request).toEqual(originalRequest);
    expect(() => predictLearnerShadow({ ...request, cutoff: "not-a-time" })).toThrow(RangeError);
    const pair = { predictions: result.predictions, correct: true, familyKey: "span:consistent-3d", predictedAt: cutoff };
    for (const threshold of [-0.01, 1.01, NaN, Infinity]) {
      expect(() => compareLearnerShadow([pair], { advanceThreshold: threshold })).toThrow("Invalid predeclared advance threshold");
    }
    for (const probability of [-0.01, 1.01, NaN, Infinity]) {
      expect(() => compareLearnerShadow([{ ...pair, predictions: result.predictions.map(row =>
        row.modelId === "classical-bkt" ? { ...row, probability } : row) }])).toThrow("Invalid persisted shadow prediction pair");
    }
    expect(compareLearnerShadow([pair])).toMatchObject({ mode: "shadow", calibrated: false, count: 1 });
    expect(result.predictions.every(row => row.calibrated === false)).toBe(true);
    expect(result).not.toHaveProperty("mastery");
    expect(snapshot).not.toHaveProperty("mastery");
    expect(await state()).toEqual(before);
    console.info("BKT_CORRECT_MODEL", JSON.stringify({ success: result.success, failure: result.failure,
      probability: bkt.probability, oracle: 4653 / 8680, ciProbability: ci.predictions[0]!.probability,
      calibrated: false, writeRejected: violation, unchangedPersistedState: true, currentReplayNotHistorical: true }));
  });
});
