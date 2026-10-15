import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRulesSkillStateEstimator, summarizeObservations, toSkillEvidence } from "@aistudy/domain";
import { readOpeningLearningEvidenceContext } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

describe("database evidence to skill estimator", () => {
  it("populates every evidence field from persisted observation and server qualification facts", async () => {
    const f = await learningAttemptFixture(fixture);
    const attempt = await f.start();
    const inserted = await f.submit(attempt, { verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: { referenceSourceId: f.sourceId, method: "Compared against the reference answer", scope: "whole_answer" } });
    const records = await f.learning.listObservationsForCourse(fixture.scope, f.courseId);
    const record = records.find(row => row.id === inserted.id)!;
    const input = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, record);
    const evidence = toSkillEvidence(record, input);

    expect(evidence).toMatchObject({
      observationId: inserted.id, courseId: f.courseId, skillLabel: "fractions", requirementKey: attempt.requirementKey,
      itemVersionId: attempt.itemVersionId, firstAttempt: null,
      outcome: "correct", assistance: "independent", verdictSource: "reference_checked", occurredAt: record.occurredAt,
    });
    for (const key of ["observationId", "courseId", "skillLabel", "requirementKey", "itemVersionId", "firstAttempt", "outcome", "assistance", "verdictSource", "occurredAt"] as const) {
      expect(Object.hasOwn(evidence, key)).toBe(true);
      expect(evidence[key]).not.toBeUndefined();
    }
    expect(evidence.record).toEqual(record);
    expect(evidence.eligibilityInput?.observation.attemptId).toBe(attempt.id);
    expect(evidence.eligibilityInput?.context.referenceCheck?.checkerId).toBe(fixture.scope.ownerUserId);
    const evaluatedAt = new Date().toISOString();
    expect(createRulesSkillStateEstimator({ evaluatedAt }).estimate([evidence]).state)
      .toBe(summarizeObservations([record], evaluatedAt, { evidenceContexts: { [record.id]: input } })[0]!.status);
  });
});
