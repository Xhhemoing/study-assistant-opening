import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { CourseRouteObservation } from "@aistudy/domain";
import { readOpeningCourseRouteRetestOutcome } from "../../packages/database/src/repositories/opening-course-route-retest-state";
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
    const { courseId, sessionId } = base;
    const attempt = await base.start({ requirementKey });
    const [session] = await f.sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${sessionId}`;
    const activityId = String(session!.activity_id);
    await f.sql`UPDATE opening_learning_attempts SET started_at=${startedAt} WHERE id=${attempt.id}`;
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
        (id,workspace_id,owner_user_id,course_id,session_id,activity_id,skill_label,requirement_key,attempt_id,retest_id,
          answer,outcome,assistance,client_key,verdict_source,recorded_at,submitted_at,workspace_history_revision)
        VALUES(${entry.id},${workspaceId},${ownerUserId},${courseId},${sessionId},${activityId},'fractions',${requirementKey},
          ${entry.attemptId},${entry.retestId},'1','correct','independent',${entry.id},'reference_checked',${entry.recordedAt},${entry.recordedAt},0)`;
    }
    const observation: CourseRouteObservation = {
      id: observationId, skillLabel: "fractions", requirementKey, attemptedAt: startedAt,
      assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes",
      usableForCurrentVersion: "yes", problemId: attempt.problemId, firstQuestionExposure: true,
      courseRequirement: { id: requirementId, revision: 1, stableSkillId, requirementKey },
    };
    const outcome = () => readOpeningCourseRouteRetestOutcome(f.sql, f.scope, retestId, observation);
    async function exposure(input: {
      domain: string; at?: string; itemVersionId?: string | null; problemId?: string | null;
      activityId?: string; released?: boolean; ownerId?: string;
    }) {
      const id = randomUUID(), released = input.released ?? true;
      await f.sql`INSERT INTO opening_help_exposures
        (id,workspace_id,owner_user_id,course_id,session_id,kind,level,delivered,release_key,released_at,support_domain,item_version_id,problem_id,activity_id)
        VALUES(${id},${workspaceId},${input.ownerId ?? ownerUserId},${courseId},NULL,'hint','hinted',${released},${id},
          ${released ? input.at ?? releaseAt : null},${input.domain},${input.itemVersionId ?? null},${input.problemId ?? null},${input.activityId ?? null})`;
      return id;
    }
    await exposure({ domain: "language", itemVersionId: attempt.itemVersionId });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, at: baselineAt });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, released: false });
    await exposure({ domain: "math", itemVersionId: attempt.itemVersionId, ownerId: f.otherScope.ownerUserId });
    expect(await outcome()).toBe("passed");

    for (const input of [
      { domain: "math", itemVersionId: attempt.itemVersionId },
      { domain: "unknown", problemId: attempt.problemId },
      { domain: "unknown", activityId },
    ]) {
      const helpId = await exposure({ ...input, at: startedAt });
      expect(await outcome()).toBe("assisted");
      await f.sql`DELETE FROM opening_help_exposures WHERE id=${helpId}`;
    }
  } finally {
    await f.close();
  }
});
