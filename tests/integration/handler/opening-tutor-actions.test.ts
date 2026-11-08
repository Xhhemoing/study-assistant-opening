import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NEXT_LEARNING_STEP_VERSION } from "@aistudy/domain";
import { applyMigrations, createSqlClient, createOpeningKnowledgeRepository,
  createOpeningLearningRepository, createOpeningSkillEvidenceRepository, readOpeningCourseEvidence } from "@aistudy/database";
import { buildDecisionInput, toSnapshotEvidence } from "@aistudy/domain";
import { createOpeningApi } from "../../../apps/web/src/features/opening/client/api";
import { createOpeningAttemptService } from "../../../apps/web/src/features/opening/learning/attempt-service";
import { backupRows } from "../opening-backup-records-fixture";
import { matrixSkill } from "../opening-matrix-attempt-fixture";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as getTutorActions } from "../../../apps/web/src/app/api/opening/courses/[id]/tutor-actions/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { insertTestTeachingActivity } from "../opening-fixture";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";
let ownerUserId = "";
let workspaceId = "";
let courseId = "";
let sessionId = "";
let otherCookie = "";

// Fixed version protocol: the combined v6 writer shares v3's D5 gold for all
// three real evaluator/HTTP cases, especially the 1/2-prior-success cases.
function assistedSuccessGold(policyVersion: string) {
  const variant = { kind: "independent_variant", problemRef: "variant:1" } as const;
  const clarify = { kind: "clarify", problemRef: null } as const;
  switch (policyVersion) {
    // v5 adds D4 cycles but keeps bridge v2 ordinary policy; D5 stays paused.
    case "next-learning-step-5":
    case "next-learning-step-2": return [variant, clarify, clarify] as const;
    case "next-learning-step-6":
    case "next-learning-step-3": return [variant, variant, variant] as const;
    default: throw new Error(`Unsupported assisted-success policy: ${policyVersion}`);
  }
}

type RegisterResult = {
  cookie: string;
  workspaceId: string;
  userId: string;
};

async function registerUser(label: string): Promise<RegisterResult> {
  const response = await register(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    }),
  );
  const body = (await response.json()) as {
    user: { id: string; workspaceId: string };
  };
  const token = response.headers
    .get("set-cookie")!
    .match(/aistudy_session=([^;]+)/)![1];
  return {
    cookie: `aistudy_session=${token}`,
    workspaceId: body.user.workspaceId,
    userId: body.user.id,
  };
}

async function countRows(table: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM ${sql(table)}
    WHERE workspace_id = ${workspaceId}`;
  return Number(rows[0]!.count);
}

function get(
  requestedCourseId: string,
  query: Record<string, string>,
  auth = cookie,
) {
  const params = new URLSearchParams(query);
  return getTutorActions(
    new Request(
      `http://localhost/api/opening/courses/${requestedCourseId}/tutor-actions?${params}`,
      { headers: { cookie: auth } },
    ),
    { params: Promise.resolve({ id: requestedCourseId }) },
  );
}

async function scoredCourse() {
  const scope = { workspaceId, ownerUserId }, rows = backupRows(sql, scope);
  const sourceId = await rows.source(), chunkId = await rows.chunk(sourceId), id = randomUUID(), nodeId = randomUUID();
  await sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${id},${workspaceId},'Canonical tutor evidence',${id})`;
  await sql`UPDATE courses SET intervention_settings='{"nodes":{"allowOnLowEvidence":true}}'::jsonb WHERE id=${id}`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${workspaceId},${id},'source',${sourceId},'core','private')`;
  const learning = createOpeningLearningRepository(sql), evidence = createOpeningSkillEvidenceRepository(sql);
  // Source admission records the real available version before graph evidence is validated.
  const session = await learning.createSession(scope, { courseId: id, skillLabel: matrixSkill, sourceIds: [sourceId] });
  await createOpeningKnowledgeRepository(sql).replace(scope, id, { expectedVersion: 0, sourceVersions: { [sourceId]: 1 },
    snapshot: { courseId: id, version: 1, edges: [], nodes: [{ id: nodeId, courseId: id, label: matrixSkill,
      kind: 'concept', status: 'supported', evidenceChunkIds: [chunkId] }] } });
  const service = createOpeningAttemptService(sql);
  const answer = async (variant: number, assisted = false, value = "[2,3]") => {
    const attempt = await service.create(scope, { sessionId: session.id, clientKey: randomUUID(),
      matrixExercise: { sourceId, exerciseKey: 'dimensions', variant } });
    if (assisted) {
      const turnId = await rows.turn(await rows.conversation(), [sourceId]);
      await sql`UPDATE opening_turns SET learning_session_id=${session.id},attempt_id=${attempt.id} WHERE id=${turnId}`;
      await learning.insertHelpExposure(scope, { id: randomUUID(), sessionId: session.id, attemptId: attempt.id,
        problemId: attempt.problemId, turnId, kind: 'hint', level: 'hinted', delivered: true });
    }
    const observation = await service.submit(scope, attempt.id, { clientKey: randomUUID(), answer: value,
      outcome: 'unverified', assistance: 'independent', verdictSource: 'self_report' });
    const link = await evidence.link(scope, { courseId: id, nodeId, observationId: observation.id, dimension: 'transfer' });
    return { observation, link };
  };
  return { id, nodeId, sourceId, learning, answer, scope };
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-k02a-tutor-actions-secret32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  const owner = await registerUser("k02a-owner");
  const other = await registerUser("k02a-other");
  cookie = owner.cookie;
  otherCookie = other.cookie;
  workspaceId = owner.workspaceId;
  ownerUserId = owner.userId;

  courseId = randomUUID();
  await sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${workspaceId}, 'K02a tutor actions', ${`k02a-${courseId}`})`;
  // Explicit opt-in allows observing no-evidence recommendations; default low-evidence gate remains closed.
  await sql`UPDATE courses SET intervention_settings='{"nodes":{"allowOnLowEvidence":true}}'::jsonb WHERE id=${courseId}`;

  sessionId = randomUUID();
  const activityId = await insertTestTeachingActivity(sql, { workspaceId, ownerUserId }, courseId);
  await sql`INSERT INTO opening_learning_sessions
    (id, workspace_id, owner_user_id, course_id, activity_id, skill_label)
    VALUES (${sessionId}, ${workspaceId}, ${ownerUserId}, ${courseId}, ${activityId}, 'chain rule')`;

  await sql`INSERT INTO opening_help_exposures
    (id, workspace_id, session_id, turn_id, kind, level, delivered)
    VALUES (${randomUUID()}, ${workspaceId}, ${sessionId}, ${randomUUID()}, 'solution', 'revealed', TRUE)`;

  const taskId = randomUUID();
  await sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, status)
    VALUES (${taskId}, ${workspaceId}, ${ownerUserId}, 'Integration retest', 15, 'pending')`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  // Due activity lives on a different skill; only the server's due/time/scope read may authorize it.
  await sql`INSERT INTO opening_retest_activities
    (id, workspace_id, owner_user_id, course_id, skill_label, purpose, evidence_cycle_id,
      task_id, status, scheduled_start_at, accepted_at)
    VALUES (${randomUUID()}, ${workspaceId}, ${ownerUserId}, ${courseId}, 'integration by parts',
      'retest', ${randomUUID()}, ${taskId}, 'accepted', ${dueAt}, ${dueAt})`;
});

afterAll(async () => {
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("K02a tutor-actions route", () => {
  it("returns clarify without performance evidence even with a selected material page", async () => {
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<{ kind: string; nodeId: string | null }>;
    };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.kind).toBe("clarify");
    expect(body.actions[0]!.nodeId).toBeNull();
    expect(body.actions[0]!).not.toHaveProperty("masteryPercent");
    expect(body.actions[0]!).not.toHaveProperty("mastery");
  });

  it("rejects client-supplied observation inputs", async () => {
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
      assistedSuccess: "1",
    });
    expect(response.status).toBe(400);
  });

  it("does not derive assisted success from a delivered reveal alone", async () => {
    const response = await get(courseId, {
      skillLabel: "chain rule",
      sessionId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<{ kind: string; problemRef: string | null }>;
    };
    expect(body.actions[0]!.kind).toBe("clarify");
    expect(body.actions[0]!.problemRef).toBeNull();
  });

  it("does not invent a verified result from hints and reveals", async () => {
    await sql`INSERT INTO opening_help_exposures
      (id, workspace_id, session_id, turn_id, kind, level, delivered)
      VALUES (${randomUUID()}, ${workspaceId}, ${sessionId}, ${randomUUID()}, 'hint', 'hinted', TRUE)`;
    const response = await get(courseId, {
      skillLabel: "chain rule",
      sessionId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: Array<{ kind: string }> };
    expect(body.actions[0]!.kind).toBe("clarify");
  });

  it("derives delayed_retest from an accepted due activity", async () => {
    // Session exposures are not grades; the existing accepted due activity is authoritative.
    const response = await get(courseId, {
      skillLabel: "integration by parts",
      currentPage: "2",
      sessionId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: Array<{ kind: string }> };
    expect(body.actions[0]!.kind).toBe("delayed_retest");
    expect(JSON.stringify(body)).not.toMatch(/masteryPercent|mastery_pct/);
  });

  it.each(["hasCheckedIndependent", "hasAssistance", "retestDue", "observationIds", "evidenceIds"])("rejects client-forged %s", async key => {
    expect((await get(courseId, { skillLabel: "derivatives", [key]: "true" })).status).toBe(400);
  });

  it("rejects a session from another course", async () => {
    const otherCourseId = randomUUID();
    await sql`INSERT INTO courses (id,workspace_id,title,slug) VALUES (${otherCourseId},${workspaceId},'Other',${otherCourseId})`;
    expect((await get(otherCourseId, { skillLabel: "chain rule", sessionId })).status).toBe(404);
  });

  it("rejects a course outside the caller workspace", async () => {
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
    }, otherCookie);
    expect(response.status).toBe(404);
  });

  it.each([0, 1, 2])("uses explicit v3 gold for latest assisted server-correct head after %i independent successes", async count => {
    expect(NEXT_LEARNING_STEP_VERSION).toBe("next-learning-step-6");
    const fixture = await scoredCourse();
    for (let index = 0; index < count; index++) await fixture.answer(index);
    const { observation, link } = await fixture.answer(count, true);
    expect(observation.eligibility).toMatchObject({ verifiedCorrect: "yes", independentAttempt: "no", usableForCurrentVersion: "yes" });
    expect(observation.serverEvaluation).toMatchObject({ evaluatorVersion: "matrix-exact-v1", decision: "correct" });
    expect(link.id).not.toBe(observation.id);
    const response = await get(fixture.id, { skillLabel: matrixSkill, nodeId: fixture.nodeId });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ ...assistedSuccessGold(NEXT_LEARNING_STEP_VERSION)[count]!, nodeId: fixture.nodeId });
    expect(body.actions[0].evidenceIds).toContain(link.id);
    expect(body.actions[0].evidenceIds).not.toContain(observation.id);
  });

  it("keeps large node/non-node responses client-parseable without clipping canonical evidence", async () => {
    const fixture = await scoredCourse();
    for (let index = 0; index < 200; index++) await fixture.answer(index % 9);
    const latest = await fixture.answer(0, false, "[3,2]");
    const evidence = await readOpeningCourseEvidence(sql, fixture.scope, fixture.id);
    const snapshot = toSnapshotEvidence(evidence, new Date());
    const decision = buildDecisionInput({ observations: snapshot.observations });
    expect(decision.observations).toHaveLength(201);
    expect(decision.observations.every(row => row.usableForCurrentVersion === "yes")).toBe(true);
    expect(decision.observations[0]!.id).toBe(latest.observation.id);
    const flags = await createOpeningSkillEvidenceRepository(sql).flagsForNode(fixture.scope, fixture.id, fixture.nodeId);
    expect(flags.evidenceIds).toHaveLength(201);
    for (const node of [false, true]) {
      const query = { skillLabel: matrixSkill, ...(node ? { nodeId: fixture.nodeId } : {}) };
      const response = await get(fixture.id, query);
      expect(response.status).toBe(200);
      const body = await response.json();
      const api = createOpeningApi(async () => Response.json(body));
      const actions = await api.listTutorActions({ courseId: fixture.id, ...query });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: "guided", nodeId: node ? fixture.nodeId : null });
      const allIds = node ? flags.evidenceIds : decision.observations.map(row => row.id);
      expect(actions[0]!.evidenceIds).toEqual([...new Set(allIds)].slice(0, 200));
      expect(new Set(actions[0]!.evidenceIds).size).toBe(200);
      expect(actions[0]!.evidenceIds).not.toContain(node ? latest.observation.id : latest.link.id);
    }
  }, 60_000);

  it("uses canonical revised heads behind old links and excludes withdrawn or stale evidence", async () => {
    const fixture = await scoredCourse(), { observation, link } = await fixture.answer(0);
    const query = { skillLabel: matrixSkill, nodeId: fixture.nodeId };
    const revised = await fixture.learning.reviseObservation(fixture.scope, { rootObservationId: observation.id,
      revisesObservationId: observation.id, expectedHead: observation.id, revisionKind: "replace", reason: "Correct transcription",
      clientKey: randomUUID(), replacement: { answer: "[2,3]", outcome: "correct", assistance: "hinted", verdictSource: "self_report" } });
    const flags = await createOpeningSkillEvidenceRepository(sql).flagsForNode(fixture.scope, fixture.id, fixture.nodeId);
    expect(flags.observationIds).toEqual([revised.headObservationId]);
    expect(flags.evidenceIds).toEqual([link.id]);
    // The learner-owned replacement is not a trusted correctness verdict.
    expect((await (await get(fixture.id, query)).json()).actions[0].kind).toBe("clarify");
    await fixture.learning.reviseObservation(fixture.scope, { rootObservationId: observation.id,
      revisesObservationId: revised.headObservationId, expectedHead: revised.headObservationId,
      revisionKind: "retract", reason: "Withdraw", clientKey: randomUUID() });
    expect((await (await get(fixture.id, query)).json()).actions[0]).toMatchObject({ kind: "clarify", evidenceIds: [] });
    await fixture.answer(1);
    await sql`UPDATE opening_sources SET version=2 WHERE id=${fixture.sourceId}`;
    expect((await (await get(fixture.id, query)).json()).actions[0]).toMatchObject({ kind: "clarify", evidenceIds: [] });
  });

  it("maps a real verified error to guided and honors the default low-evidence and quiet gates", async () => {
    const fixture = await scoredCourse();
    const { observation } = await fixture.answer(0, false, "[3,2]");
    expect((await (await get(fixture.id, { skillLabel: matrixSkill })).json()).actions[0])
      .toMatchObject({ kind: "guided", evidenceIds: [observation.id] });
    await sql`UPDATE courses SET intervention_settings=NULL WHERE id=${fixture.id}`;
    expect((await (await get(fixture.id, { skillLabel: "unobserved", nodeId: randomUUID() })).json()).actions).toEqual([]);
    await sql`UPDATE courses SET intervention_settings='{"quietMode":true}'::jsonb WHERE id=${fixture.id}`;
    expect((await (await get(fixture.id, { skillLabel: matrixSkill })).json()).actions).toEqual([]);
  });

  it("performs a read-only recommendation", async () => {
    const beforeSessionCount = await countRows("opening_learning_sessions");
    const beforeExposureCount = await countRows("opening_help_exposures");
    const beforeTaskCount = await countRows("opening_tasks");
    const response = await get(courseId, {
      skillLabel: "chain rule",
      currentPage: "2",
      sessionId,
    });
    expect(response.status).toBe(200);
    expect(await countRows("opening_learning_sessions")).toBe(beforeSessionCount);
    expect(await countRows("opening_help_exposures")).toBe(beforeExposureCount);
    expect(await countRows("opening_tasks")).toBe(beforeTaskCount);
  });
});
