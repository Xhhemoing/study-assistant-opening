import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openingEligibilityStateQuery, readOpeningCourseLearningSummary } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => {
  if (!fixture) return;
  try {
    const scopes = [fixture.scope.workspaceId, fixture.otherScope.workspaceId], users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
    await fixture.sql.begin(async tx => {
      await tx`DELETE FROM opening_learning_sessions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_learning_item_versions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_learning_history_revisions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_source_versions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM courses WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM workspaces WHERE id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM sessions WHERE user_id=ANY(${users}::uuid[])`;
      await tx`DELETE FROM users WHERE id=ANY(${users}::uuid[])`;
    });
  } finally { await fixture.close(); }
});
it("keeps current-head eligibility in the same transaction as new facts and retractions", async () => {
  const f = await learningAttemptFixture(fixture), observation = await f.submit(await f.start());
  const rows = await fixture.sql`SELECT head_observation_id,independent_attempt FROM opening_learning_eligibility
    WHERE workspace_id=${fixture.scope.workspaceId} AND root_observation_id=${observation.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ head_observation_id: observation.id, independent_attempt: "yes" });
  await f.learning.reviseObservation(fixture.scope, { rootObservationId: observation.id, revisesObservationId: observation.id, expectedHead: observation.id,
    revisionKind: "retract", reason: "withdrawn", clientKey: randomUUID() });
  expect(await fixture.sql`SELECT 1 FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`).toHaveLength(0);
});
it("repairs exact source and policy dependencies without advancing the semantic revision", async () => {
  const f = await learningAttemptFixture(fixture), observation = await f.submit(await f.start());
  const before = await readOpeningCourseLearningSummary(fixture.sql, fixture.scope, { courseId: f.courseId, limit: 10 });
  expect(before.status).toBe("ready");
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  const stale = await openingEligibilityStateQuery(fixture.sql, fixture.scope, { rootIds: [observation.id] });
  expect(stale[0]?.fresh).toBe(false);
  const after = await readOpeningCourseLearningSummary(fixture.sql, fixture.scope, { courseId: f.courseId, limit: 10 });
  expect(after.snapshotRevision).toBe(before.snapshotRevision);
  expect(after.groups[0]?.representatives[0]?.versionApplicability).toBe("changed_needs_check");
  await fixture.sql`UPDATE opening_learning_eligibility SET policy_version='old-policy' WHERE root_observation_id=${observation.id}`;
  const rebuilt = await readOpeningCourseLearningSummary(fixture.sql, fixture.scope, { courseId: f.courseId, limit: 10 });
  expect(rebuilt.status).toBe("ready");
  expect(rebuilt.groups[0]?.representatives[0]?.eligibility.policyVersion).toBe("opening-evidence-v1");
  expect(rebuilt.groups[0]?.representatives[0]?.eligibility.usableForDelayedCheck).toBe("unknown");
});
it("automatically repairs bounded batches before exposing complete group statistics", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start({ requirementKey: "legacy" }));
  await fixture.sql`INSERT INTO opening_learning_observations(id,workspace_id,owner_user_id,session_id,course_id,skill_label,source_ids,problem_id,retest_id,
      answer,outcome,assistance,client_key,occurred_at,source_turn_ids,verdict_source,reference_source_id,evidence_verdict,
      requirement_key,recorded_at,source_versions,history_revision,workspace_history_revision,root_observation_id,effective_head_id,revision_kind,actor_id)
    SELECT ids.id,o.workspace_id,o.owner_user_id,o.session_id,o.course_id,o.skill_label,o.source_ids,o.problem_id,NULL,
      o.answer,o.outcome,o.assistance,ids.id::text,o.occurred_at,o.source_turn_ids,o.verdict_source,o.reference_source_id,o.evidence_verdict,
      o.requirement_key,o.recorded_at,o.source_versions,0,0,ids.id,ids.id,'original',o.owner_user_id
    FROM opening_learning_observations o CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,120)) ids WHERE o.id=${original.id}`;
  await fixture.sql`DELETE FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId}`;
  const first = await readOpeningCourseLearningSummary(fixture.sql, fixture.scope, { courseId: f.courseId, limit: 10 });
  expect(first.status).toBe("updating"); expect(first.groups).toEqual([]); expect(first.pendingProjectionCount).toBe(21);
  const second = await readOpeningCourseLearningSummary(fixture.sql, fixture.scope, { courseId: f.courseId, limit: 10, groupCursor: first.nextCursor! });
  expect(second.status).toBe("ready"); expect(second.snapshotRevision).toBe(first.snapshotRevision);
  expect(second.groups[0]).toMatchObject({ sampleCount: 121, unverifiedCount: 121 });
  expect(second.groups[0]?.representatives).toHaveLength(20);
  await fixture.sql`DELETE FROM opening_learning_sessions WHERE id=${f.sessionId}`;
  expect(await fixture.sql`SELECT 1 FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId}
    AND root_observation_id=${original.id}`).toHaveLength(0);
});
