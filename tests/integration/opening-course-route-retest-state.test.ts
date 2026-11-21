import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { evaluateEvidenceEligibility, type CourseRouteObservation } from "@aistudy/domain";
import { createOpeningStudyExposureRepository } from "../../packages/database/src/repositories/opening-study-exposure";
import { readOpeningCourseRouteRetestOutcome } from "../../packages/database/src/repositories/opening-course-route-retest-state";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { mapLearningObservation } from "../../packages/database/src/repositories/opening-learning-facts";
import { createOpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

it("attributes released interval help by scoped item, problem and activity when no session is stored", async () => {
  const f = await createOpeningFixture();
  try {
    const base = await learningAttemptFixture(f);
    const requirementId = randomUUID(), stableSkillId = randomUUID(), retestId = randomUUID();
    const baselineId = randomUUID(), observationId = randomUUID(), requirementKey = "fraction-addition";
    const baselineAt = "2026-11-18T10:00:00Z", startedAt = "2026-11-18T11:00:00Z";
    const releaseAt = "2026-11-18T10:30:00Z";
    const { workspaceId, ownerUserId } = f.scope;
    const { courseId, sessionId, sourceId } = base;
    await f.sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,bytes,sha256,availability)
      SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId} ON CONFLICT DO NOTHING`;
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
    await f.sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,bytes,sha256,availability)
      SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId} ON CONFLICT DO NOTHING`;
    const [currentChunk] = await f.sql`INSERT INTO opening_source_chunks (source_id,source_version,page,text)
      VALUES(${sourceId},2,1,'Revised source evidence') RETURNING id`;
    const attempt = await base.start({ requirementKey, problem: { sourceId, chunkId: currentChunk!.id, physicalPage: 1,
      stemSnapshot: "1/2 + 1/2?", artifactKind: "reference_item" } });
    expect(attempt.sourceVersions).toEqual({ [sourceId]: 2 });
    const priorAttempt = await base.attempts.create(f.scope, { clientKey: randomUUID(), sessionId, problemId: attempt.problemId!, requirementKey });
    expect(priorAttempt.itemVersionId).toBe(attempt.itemVersionId);
    const [session] = await f.sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${sessionId}`;
    const activityId = String(session!.activity_id);
    await f.sql`UPDATE opening_learning_attempts SET started_at=${startedAt},submitted_at='2026-11-18T11:05:00Z' WHERE id=${attempt.id}`;
    await f.sql`UPDATE opening_teaching_activities SET goal_json=${f.sql.json({ courseRoute: { requirementId } })} WHERE id=${activityId}`;
    await f.sql`INSERT INTO opening_retest_activities
      (id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,status,learning_protocol)
      VALUES(${retestId},${workspaceId},${ownerUserId},${courseId},'fractions',${requirementKey},${randomUUID()},'completed',
        ${f.sql.json({ protocolId: "course-route-delayed-v1", goalId: randomUUID(), goalRevision: 1,
          requirementId, requirementRevision: 1, stableSkillId, baselineObservationId: baselineId, baselineRootId: baselineId,
          originActivityId: activityId, minutes: 20 })})`;
    for (const entry of [
      { id: baselineId, attemptId: null, retestId: null, recordedAt: baselineAt },
      { id: observationId, attemptId: attempt.id, retestId, recordedAt: "2026-11-18T11:05:00Z" },
    ]) {
      await f.sql`INSERT INTO opening_learning_observations
        (id,workspace_id,owner_user_id,course_id,session_id,activity_id,skill_label,requirement_key,attempt_id,retest_id,source_ids,source_versions,
          answer,outcome,assistance,client_key,verdict_source,recorded_at,submitted_at,workspace_history_revision)
        VALUES(${entry.id},${workspaceId},${ownerUserId},${courseId},${sessionId},${activityId},'fractions',${requirementKey},
          ${entry.attemptId},${entry.retestId},${[sourceId]},${f.sql.json({ [sourceId]: entry.retestId ? 2 : 1 })},
          '1','correct','independent',${entry.id},'reference_checked',${entry.recordedAt},${entry.recordedAt},0)`;
    }
    const observation: CourseRouteObservation = {
      id: observationId, skillLabel: "fractions", requirementKey, attemptedAt: startedAt,
      assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes",
      usableForCurrentVersion: "yes", problemId: attempt.problemId, firstQuestionExposure: true,
      courseRequirement: { id: requirementId, revision: 1, stableSkillId, requirementKey },
    };
    const outcome = (independentAttempt = observation.independentAttempt) =>
      readOpeningCourseRouteRetestOutcome(f.sql, f.scope, retestId, { ...observation, independentAttempt });
    async function exposure(input: {
      domain: string; at?: string; itemVersionId?: string | null; problemId?: string | null;
      activityId?: string; released?: boolean; ownerId?: string; attemptId?: string; attemptOnly?: boolean; course?: string;
      sourceId?: string; sourceRefs?: string[]; skillLabel?: string; requirementKey?: string; sessionId?: string;
    }) {
      const id = randomUUID(), released = input.released ?? true;
      const deliveredAt = released ? input.at ?? releaseAt : null;
      await f.sql`INSERT INTO opening_help_exposures
        (id,workspace_id,owner_user_id,course_id,session_id,kind,level,delivered,release_key,released_at,delivered_at,support_domain,item_version_id,problem_id,activity_id,attempt_id,context_anchor,release_intent)
        VALUES(${id},${workspaceId},${input.ownerId ?? ownerUserId},${input.course ?? courseId},${input.sessionId ?? null},'hint','hinted',${released},${id},
          ${deliveredAt},${deliveredAt},${input.domain},${input.itemVersionId ?? null},${input.problemId ?? null},${input.activityId ?? null},
          ${input.attemptId ?? null},${input.sourceId ? f.sql.json({ sourceId: input.sourceId }) : null},
          ${f.sql.json({ originReference: { possibleOpenAttemptOnly: input.attemptOnly ?? false, skillLabel: input.skillLabel ?? null,
            requirementKey: input.requirementKey ?? null, sourceRefs: (input.sourceRefs ?? []).map(sourceId => ({ sourceId, sourceVersion: 2 })) } })})`;
      return id;
    }
    await exposure({ domain: "language", itemVersionId: attempt.itemVersionId });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, at: baselineAt });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, released: false });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, ownerId: f.otherScope.ownerUserId });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, course: randomUUID() });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, attemptId: priorAttempt.id });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, attemptOnly: true });
    await exposure({ domain: "math", activityId, sourceId: randomUUID() });
    await exposure({ domain: "math", activityId, sourceRefs: [randomUUID()] });
    await exposure({ domain: "math", activityId, skillLabel: "unrelated" });
    await exposure({ domain: "math", activityId, requirementKey: "unrelated" });
    await exposure({ domain: "math", attemptId: attempt.id, at: "2026-11-18T11:06:00Z" });
    expect(await outcome()).toBe("passed");
    const projected = async () => {
      const [row] = await f.sql`SELECT * FROM opening_learning_observations WHERE id=${observationId}`;
      const { observation, context } = await readOpeningLearningEvidenceContext(f.sql, f.scope, mapLearningObservation(row!));
      return evaluateEvidenceEligibility(observation, context);
    };
    await f.sql`UPDATE opening_learning_observations SET started_at=${startedAt},problem_id=${attempt.problemId},
      item_version_id=${attempt.itemVersionId} WHERE id=${observationId}`;
    expect((await projected()).independentAttempt).toBe("yes");

    for (const unrelated of [
      { sourceId: randomUUID() }, { sourceRefs: [randomUUID()] }, { skillLabel: "unrelated" },
      { requirementKey: "unrelated" }, { course: randomUUID() }, { domain: "language" },
    ]) {
      const helpId = await exposure({ domain: "math", sessionId, ...unrelated });
      const evidence = await projected();
      expect(evidence.independentAttempt, JSON.stringify(unrelated)).toBe("yes");
      expect(await outcome(evidence.independentAttempt)).toBe("passed");
      await f.sql`DELETE FROM opening_help_exposures WHERE id=${helpId}`;
    }
    const inScopeHelp = await exposure({ domain: "math", sessionId, sourceId, at: startedAt });
    expect((await projected()).independentAttempt).toBe("no");
    expect(await outcome()).toBe("assisted");
    await f.sql`DELETE FROM opening_help_exposures WHERE id=${inScopeHelp}`;
    const legacyOnly = await exposure({ domain: "math", sessionId, sourceId, at: baselineAt });
    expect((await projected()).independentAttempt).toBe("unknown");
    await f.sql`DELETE FROM opening_help_exposures WHERE id=${legacyOnly}`;

    for (const input of [
      { domain: "math", itemVersionId: attempt.itemVersionId },
      { domain: "unknown", problemId: attempt.problemId },
      { domain: "unknown", activityId },
      { domain: "math", sourceRefs: [sourceId] },
    ]) {
      const helpId = await exposure({ ...input, at: startedAt });
      expect(await outcome()).toBe("assisted");
      await f.sql`DELETE FROM opening_help_exposures WHERE id=${helpId}`;
    }

    await f.sql`UPDATE opening_teaching_activities SET goal_json='{}' WHERE id=${activityId}`;
    const exposures = createOpeningStudyExposureRepository(f.sql);
    for (const pin of ["anchor", "origin"] as const) {
      const historical = await exposures.deliver(f.scope, {
        releaseKey: randomUUID(), origin: "assistant", kind: "hint", level: "hinted", supportDomain: "math", sessionId,
        contextAnchor: pin === "anchor" ? { purpose: "learning_help", courseId, sourceId, sourceVersion: 1 }
          : { purpose: "learning_help", courseId },
        ...(pin === "origin" ? { originReference: { type: "source" as const, id: sourceId, version: "1",
          sourceRefs: [{ sourceId, sourceVersion: 1 }] } } : {}),
      });
      expect(historical.contextAnchor).toMatchObject({ attemptId: null, itemVersionId: null });
      if (pin === "anchor") expect(historical.contextAnchor).toMatchObject({ sourceId, sourceVersion: 1 });
      await f.sql`UPDATE opening_help_exposures SET released_at=${startedAt},delivered_at=${startedAt},workspace_history_revision=0
        WHERE id=${historical.id}`;
      expect({ outcome: await outcome(), independence: (await projected()).independentAttempt }, pin)
        .toEqual({ outcome: "passed", independence: "yes" });
      await f.sql`UPDATE opening_help_exposures SET released_at=${baselineAt},delivered_at=${baselineAt} WHERE id=${historical.id}`;
      expect(await outcome()).toBe("passed");
      expect((await projected()).independentAttempt).toBe("yes");
      await f.sql`DELETE FROM opening_help_exposures WHERE id=${historical.id}`;
    }
    // An activity-only receipt counts once the answer captures its delivery.
    const delivered = await exposures.deliver(f.scope, {
      releaseKey: randomUUID(), origin: "assistant", kind: "hint", level: "hinted", supportDomain: "math",
      contextAnchor: { purpose: "learning_help", courseId, activityId },
    });
    expect(delivered.contextAnchor).toMatchObject({ activityId, attemptId: null, itemVersionId: null });
    expect(await outcome()).toBe("passed");
    expect((await projected()).independentAttempt).toBe("yes");
    const [receipt] = await f.sql`SELECT workspace_history_revision FROM opening_help_exposures WHERE id=${delivered.id}`;
    const [captured] = await f.sql`UPDATE opening_learning_attempts SET submitted_at=clock_timestamp() WHERE id=${attempt.id} RETURNING submitted_at`;
    await f.sql`UPDATE opening_learning_observations SET submitted_at=${captured!.submitted_at},recorded_at=${captured!.submitted_at},
      workspace_history_revision=${Number(receipt!.workspace_history_revision) + 1} WHERE id=${observationId}`;
    expect(await outcome()).toBe("assisted");
    expect((await projected()).independentAttempt).toBe("no");
    await f.sql`UPDATE opening_learning_attempts SET submitted_at=NULL WHERE id=${attempt.id}`;
    expect(await outcome()).toBe("assisted");
  } finally {
    await f.close();
  }
});
