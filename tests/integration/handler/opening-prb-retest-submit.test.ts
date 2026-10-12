import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import { createOpeningKnowledgeRepository, createOpeningSkillEvidenceRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";
import { backupRows } from "../opening-backup-records-fixture";

/**
 * PR-B §4.1 handler-level (real PG): the server re-checks retest timing and
 * independence on attempt submit. Current contract: an early retest-linked submit is
 * rejected and nothing is written; early practice without retestId is saved but is
 * not retest evidence.
 */
let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
const nodeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1";
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600 });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations,opening_retest_activities CASCADE`; });
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });

const req = (body: unknown) => new Request("http://localhost/api/opening/attempts/x/submit", { method: "POST",
  headers: { cookie: fixture.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const answer = (extra: Record<string, unknown> = {}) => ({ clientKey: randomUUID(), answer: "1", outcome: "correct", assistance: "independent", ...extra });

async function setup(recommendedAt: Date) {
  const f = await learningAttemptFixture(fixture);
  await fixture.sql`INSERT INTO course_asset_memberships (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${f.courseId}, 'source', ${f.sourceId}, 'core', 0, 'course')`;
  const snapshot: KnowledgeSnapshot = { courseId: f.courseId, version: 1,
    nodes: [{ id: nodeId, courseId: f.courseId, label: "fractions", kind: "concept", evidenceChunkIds: [f.chunkId], status: "supported" }], edges: [] };
  await createOpeningKnowledgeRepository(fixture.sql).replace(fixture.scope, f.courseId, { expectedVersion: 0, snapshot, sourceVersions: { [f.sourceId]: 1 } });
  const candidateId = randomUUID(), retestId = randomUUID();
  await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
    VALUES (${candidateId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest',
      ${fixture.sql.json({ kind: "task", id: candidateId, courseId: f.courseId, skillLabel: "fractions", prompt: "p", sourceIds: [f.sourceId], dueAt: null, accepted: true } as never)}, 'succeeded')`;
  await fixture.sql`INSERT INTO opening_retest_activities (id, workspace_id, owner_user_id, course_id, skill_label, evidence_cycle_id,
      candidate_id, status, accepted_at, not_before_at, recommended_at)
    VALUES (${retestId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${f.courseId}, 'fractions', ${randomUUID()},
      ${candidateId}, 'accepted', now(), ${recommendedAt}, ${recommendedAt})`;
  const attempt = await f.start();
  return { f, attempt, retestId };
}
// Same as the shared fixture's help(), plus the now-required exposure kind (fixture predates it).
async function deliverHint(f: Awaited<ReturnType<typeof learningAttemptFixture>>, attempt: { id: string; problemId: string | null }) {
  const rows = backupRows(fixture.sql, fixture.scope);
  const conversation = await rows.conversation(), turnId = await rows.turn(conversation, [f.sourceId]);
  await fixture.sql`UPDATE opening_turns SET learning_session_id=${f.sessionId},attempt_id=${attempt.id} WHERE id=${turnId}`;
  await f.learning.insertHelpExposure(fixture.scope, { id: randomUUID(), attemptId: attempt.id, sessionId: f.sessionId,
    problemId: attempt.problemId, turnId, level: "hinted", delivered: true, kind: "hint" } as never);
}
const evidenceFor = (observationId: string) => createOpeningSkillEvidenceRepository(fixture.sql).listByObservation(fixture.scope, observationId);
const hourAgo = () => new Date(Date.now() - 3_600_000);
const inHour = () => new Date(Date.now() + 3_600_000);

describe("attempt submit retest checks (handler, real PG)", () => {
  it("early retest-linked submit is rejected and writes nothing", async () => {
    const { attempt, retestId } = await setup(inHour());
    const response = await submitAttempt(req(answer({ retestId })), params(attempt.id));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "VALIDATION", businessCode: "RETEST_SUBMIT_TOO_EARLY" });
    expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id = ${attempt.id}`).toHaveLength(0);
  });

  it("on-time independent correct retest counts as skill evidence", async () => {
    const { attempt, retestId } = await setup(hourAgo());
    const response = await submitAttempt(req(answer({ retestId })), params(attempt.id));
    expect(response.status).toBe(201);
    const observation = await response.json();
    expect(observation).toMatchObject({ assistance: "independent", retestId });
    const links = await evidenceFor(observation.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ nodeId, dimension: "transfer" });
  });

  it("delivered hint: client 'independent' claim is overridden to hinted and does not count", async () => {
    const { f, attempt, retestId } = await setup(hourAgo());
    await deliverHint(f, attempt);
    const response = await submitAttempt(req(answer({ retestId })), params(attempt.id));
    expect(response.status).toBe(201);
    const observation = await response.json();
    expect(observation.assistance).toBe("hinted");
    expect(await evidenceFor(observation.id)).toHaveLength(0);
  });

  it("early practice without retestId is saved but carries no retest link or evidence", async () => {
    const { attempt } = await setup(inHour());
    const response = await submitAttempt(req(answer()), params(attempt.id));
    expect(response.status).toBe(201);
    const observation = await response.json();
    expect(observation.retestId ?? null).toBeNull();
    expect(await evidenceFor(observation.id)).toHaveLength(0);
    const rows = await fixture.sql`SELECT retest_id FROM opening_learning_observations WHERE id = ${observation.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retest_id).toBeNull();
  });
});
