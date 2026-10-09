import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningLearningRepository, readOpeningRetestReviewCandidates } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

/**
 * DL3 data half: ordinary observation enqueues a retest-scan job + outbox in the
 * same transaction. Requires OPENING_TEST_DB=1 and isolated aistudy_opening_test.
 */
describe("opening retest scan enqueue (DL3)", () => {
  let fixture: OpeningFixture;
  const courseId = randomUUID();

  beforeAll(async () => {
    fixture = await createOpeningFixture();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug)
      VALUES (${courseId},${fixture.scope.workspaceId},'Scan course',${courseId})`;
  });

  beforeEach(async () => {
    await fixture.sql`TRUNCATE opening_outbox, opening_jobs, opening_learning_observations,
      opening_help_exposures, opening_problem_refs, opening_learning_sessions,
      opening_source_chunks, opening_sources, opening_retest_activities, opening_tasks
      RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("writes one queued retest-scan job and outbox row for an ordinary observation", async () => {
    const learning = createOpeningLearningRepository(fixture.sql);
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "geometry", sourceIds: [],
    });
    const observation = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "90", outcome: "unverified", assistance: "unknown", clientKey: "scan-obs-key-01",
    });

    const jobs = await fixture.sql`
      SELECT id, key, kind, state, payload FROM opening_jobs
      WHERE workspace_id=${fixture.scope.workspaceId} AND key=${`retest-scan:${courseId}:${observation.id}`}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "retest", state: "queued" });
    expect((jobs[0]!.payload as { courseId: string; observationId: string; kind?: string }).kind).toBeUndefined();
    expect(jobs[0]!.payload).toMatchObject({ courseId, observationId: observation.id });

    const outbox = await fixture.sql`
      SELECT topic, payload FROM opening_outbox WHERE job_id=${jobs[0]!.id as string}`;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ topic: "opening.job.enqueue" });
    expect(outbox[0]!.payload).toMatchObject({ kind: "retest", courseId, observationId: observation.id });
  });

  it("replays the same clientKey without a second scan job", async () => {
    const learning = createOpeningLearningRepository(fixture.sql);
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "geometry", sourceIds: [],
    });
    const body = {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [] as string[],
      answer: "90", outcome: "unverified" as const, assistance: "unknown" as const, clientKey: "scan-obs-replay",
    };
    const first = await learning.insertObservation(fixture.scope, body);
    const replay = await learning.insertObservation(fixture.scope, body);
    expect(replay.id).toBe(first.id);

    const jobs = await fixture.sql`
      SELECT id FROM opening_jobs
      WHERE workspace_id=${fixture.scope.workspaceId} AND key=${`retest-scan:${courseId}:${first.id}`}`;
    expect(jobs).toHaveLength(1);
  });

  it("does not enqueue a scan when the observation closes a retest", async () => {
    const learning = createOpeningLearningRepository(fixture.sql);
    const candidateId = randomUUID();
    const activityId = randomUUID();
    const taskId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
      VALUES (
        ${candidateId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId},
        ${`retest:${candidateId}`}, ${"retest"},
        ${fixture.sql.json({ kind: "task", courseId, skillLabel: "fractions", prompt: "stem", accepted: true, taskId } as never)},
        ${"succeeded"}
      )`;
    await fixture.sql`
      INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, candidate_id)
      VALUES (${taskId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, '补测', 20, null, 1, 'pending', 1, ${candidateId})`;
    await fixture.sql`
      INSERT INTO opening_retest_activities (
        id, workspace_id, owner_user_id, course_id, skill_label, purpose, evidence_cycle_id,
        candidate_id, task_id, status, version
      ) VALUES (
        ${activityId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${courseId}, 'fractions', 'retest',
        ${candidateId}, ${candidateId}, ${taskId}, 'accepted', 1
      )`;

    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [],
    });
    const observation = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [],
      retestId: activityId, answer: "1", outcome: "correct", assistance: "independent", clientKey: "scan-obs-retest",
    });

    const scans = await fixture.sql`
      SELECT id FROM opening_jobs
      WHERE workspace_id=${fixture.scope.workspaceId} AND key=${`retest-scan:${courseId}:${observation.id}`}`;
    expect(scans).toHaveLength(0);
  });

  it("keeps scan jobs out of the reviewable retest proposal list", async () => {
    const learning = createOpeningLearningRepository(fixture.sql);
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "geometry", sourceIds: [],
    });
    await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "90", outcome: "unverified", assistance: "unknown", clientKey: "scan-obs-list",
    });
    // Mark scan succeeded without kind=task — review filter requires payload.kind='task'.
    await fixture.sql`
      UPDATE opening_jobs SET state='succeeded'
      WHERE workspace_id=${fixture.scope.workspaceId}
        AND key LIKE ${`retest-scan:${courseId}:%`}`;

    const listed = await readOpeningRetestReviewCandidates(fixture.sql, fixture.scope);
    expect(listed).toEqual([]);
  });
});
