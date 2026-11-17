import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { addRequestMeta } from "next/dist/server/request-meta";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createOpeningAdaptivePrefsRepository, createOpeningCourseRouteRepository,
  createOpeningLearningGoalRepository, createOpeningLearningAttemptRepository,
  createOpeningSpanSessionRepository, createWorkspacePreferencesRepository, hashSessionToken,
} from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { backupRows } from "../opening-backup-records-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { createSessionJwt } from "../../../apps/web/src/lib/session";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST } from "../../../apps/web/src/app/api/opening/teaching/activities/[id]/learning-advice/route";

// The serial handler project's globalSetup migrates the isolated opt-in PG.
// Never substitute mock auth or mock SQL.
const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);
const secret = "learning-advice-synthetic-secret-at-least-32-characters";
let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
let own: Awaited<ReturnType<typeof seed>>, other: Awaited<ReturnType<typeof seed>>, otherCookie: string;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
async function seed(scope: OpeningFixture["scope"]) {
  const { sql } = f, rows = backupRows(sql, scope), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  const courseId = randomUUID(), requirementId = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Synthetic advice',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope,
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  await createOpeningAdaptivePrefsRepository(sql).patch(scope,
    { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 180, expiresOn: null, expectedRevision: 0 } });
  const goal = await createOpeningLearningGoalRepository(sql).create(scope, { clientKey: randomUUID(), courseIds: [courseId],
    title: "Synthetic advice goal", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120,
    priority: 1, learningMode: "understand", successCriteria: "Independent solution" });
  const route = createOpeningCourseRouteRepository(sql, { compilerEnabled: true, exactVerificationEnabled: true });
  await route.confirm(scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{
    id: requirementId, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: SPAN_REQUIREMENT_KEY,
    title: "Synthetic span", position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], origin: "confirmed",
    verification: { kind: "exact", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] },
  }], spanBindings: [{ requirementId, exerciseKeys: ["span-example-2d"], confirmContent: true }] });
  const started = await route.start(scope, courseId, { goalId: goal.id, expectedGoalRevision: goal.revision,
    requirementId, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(`Synthetic start failed: ${started.reason}`);
  const session = await createOpeningSpanSessionRepository(sql).get(scope, started.activity.id);
  if (!session) throw new Error("Synthetic session missing");
  const attempts = await createOpeningLearningAttemptRepository(sql).listByActivity(scope, session.activityId);
  if (attempts.length !== 1) throw new Error("Synthetic anchor missing");
  return { courseId, sourceId, chunkId, goalId: goal.id, requirementId, session, attempt: attempts[0]! };
}
function request(input: { cookie?: string; body?: unknown; id?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const id = input.id ?? own.session.activityId;
  return POST(new Request(`http://localhost/api/opening/teaching/activities/${id}/learning-advice`, {
    method: "POST", headers: { cookie: input.cookie ?? f.cookie, origin: "http://localhost", "content-type": "application/json", ...input.headers },
    body: input.raw ?? JSON.stringify(input.body ?? { attemptId: own.attempt.id, expectedRevision: own.session.revision, optIn: false }),
  }), context(id));
}
async function checked(response: Response, status: number) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (status !== 200) expect(body).toMatchObject({ error: { code: expect.any(String) } });
  return body;
}
async function cookieFor(claims: { sub?: string; workspaceId?: string; sid?: string } = {}, options: {
  key?: string; ttl?: number; hash?: string; expired?: boolean; revoked?: boolean; absent?: boolean;
} = {}) {
  const sid = claims.sid ?? randomUUID(), sub = claims.sub ?? f.scope.ownerUserId;
  const token = await createSessionJwt({ sub, sid, workspaceId: claims.workspaceId ?? f.scope.workspaceId }, options.key ?? secret, options.ttl ?? 3600);
  if (!options.absent) await f.sql`INSERT INTO sessions(id,user_id,token_hash,expires_at,revoked_at)
    VALUES(${sid},${f.scope.ownerUserId},${options.hash ?? hashSessionToken(token)},
      ${new Date(Date.now() + (options.expired ? -60_000 : 3600_000))},${options.revoked ? new Date() : null})`;
  return `aistudy_session=${token}`;
}

describe.skipIf(!enabled)("real authenticated rule-only advice handler / PG16", () => {
  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("PUBLIC_BASE_URL", "");
    vi.stubEnv("AUTH_SECRET", secret); vi.stubEnv("OPENING_TEACHING_LOOP", "1");
    vi.stubEnv("OPENING_TEACHING_LOOP_ROLLOUT_USER_IDS", "");
    f = await createOpeningFixture();
    runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: secret,
      sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
    setAuthRuntimeForTests(runtime);
    own = await seed(f.scope); other = await seed(f.otherScope);
    const issued = await runtime.sessions.issue({ userId: f.otherScope.ownerUserId, workspaceId: f.otherScope.workspaceId });
    otherCookie = `aistudy_session=${issued.token}`;
  }, 60_000);
  afterAll(async () => {
    setAuthRuntimeForTests(null); vi.restoreAllMocks(); vi.unstubAllEnvs();
    try { await runtime?.close(); } finally { await f?.close(); }
  });

  it("accepts the configured public origin through the pinned native Next proxy adapter, not the internal host", async () => {
    const publicOrigin = "https://study.example", path = `/api/opening/teaching/activities/${own.session.activityId}/learning-advice`;
    // Offline Node transport -> actual locked Next adapter -> actual route/auth/SQL.
    // initURL mirrors trustHostHeader=false: the server hostname/port, not forwarded Host.
    const adapted = (origin: string | null, cookie = f.cookie) => {
      const incoming = new IncomingMessage(new Socket());
      incoming.method = "POST"; incoming.url = path;
      incoming.headers = { host: "study.example", "x-forwarded-host": "study.example", "x-forwarded-proto": "https",
        cookie, "content-type": "application/json", ...(origin === null ? {} : { origin }) };
      const nodeRequest = new NodeNextRequest(incoming);
      addRequestMeta(nodeRequest, "initURL", `http://localhost:18090${path}`);
      incoming.push(Buffer.from(JSON.stringify({ attemptId: own.attempt.id, expectedRevision: own.session.revision, optIn: true })));
      incoming.push(null);
      const result = NextRequestAdapter.fromNodeNextRequest(nodeRequest, new AbortController().signal);
      expect(result.url).toBe(`http://localhost:18090${path}`);
      return result;
    };
    const snapshot = () => f.sql`SELECT
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM opening_teaching_activities a) AS activities,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM opening_learning_sessions s) AS sessions,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM opening_learning_attempts p) AS attempts,
      (SELECT count(*) FROM opening_learning_decisions) AS decisions,
      (SELECT count(*) FROM opening_budget_reservations) AS budgets`;
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PUBLIC_BASE_URL", ` ${publicOrigin} `);
    try {
      const before = await snapshot();
      expect(await checked(await POST(adapted(publicOrigin), context(own.session.activityId)), 200))
        .toMatchObject({ messageCode: "rule_only", experimentState: "off", advice: { status: "disabled", experimentalAdvice: null } });
      for (const origin of ["https://foreign.invalid", "not-an-origin", "null", "", null, "http://localhost:18090"])
        await checked(await POST(adapted(origin), context(own.session.activityId)), 400);
      for (const origin of [publicOrigin, "https://foreign.invalid", "not-an-origin"])
        expect(await checked(await POST(adapted(origin, ""), context(own.session.activityId)), 401))
          .toMatchObject({ error: { code: "UNAUTHENTICATED" } });
      expect(await snapshot()).toEqual(before);
    } finally { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("PUBLIC_BASE_URL", ""); }
  });

  it.each([false, true])("projects only the current rule, optIn=%s remains off and writes nothing", async optIn => {
    const snapshot = () => f.sql`SELECT (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM opening_teaching_activities a) AS activities,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM opening_learning_sessions s) AS sessions,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM opening_learning_attempts p) AS attempts,
      (SELECT count(*) FROM opening_learning_decisions) AS decisions,
      (SELECT count(*) FROM opening_budget_reservations) AS budgets`;
    const before = await snapshot();
    const body = await checked(await request({ body: { attemptId: own.attempt.id, expectedRevision: own.session.revision, optIn } }), 200);
    expect(body).toEqual({ advice: { ruleDecision: { activityKind: expect.any(String), reasonCode: expect.any(String) },
      status: "disabled", experimentalAdvice: null }, experimentState: "off", messageCode: "rule_only" });
    for (const privateValue of [own.sourceId, own.attempt.id, own.session.sessionId, other.courseId, "sourceVersions", "probability"])
      expect(JSON.stringify(body)).not.toContain(privateValue);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["missing", "bad-signature", "jwt-expired", "sid-missing", "hash-mismatch", "db-expired", "revoked", "sub-mismatch", "workspace-mismatch"])("rejects real auth %s", async kind => {
    const cookie = kind === "missing" ? "" : await cookieFor({
      ...(kind === "sub-mismatch" ? { sub: f.otherScope.ownerUserId } : {}),
      ...(kind === "workspace-mismatch" ? { workspaceId: f.otherScope.workspaceId } : {}),
    }, { key: kind === "bad-signature" ? "different-synthetic-signing-secret-32-characters" : secret,
      ttl: kind === "jwt-expired" ? -60 : 3600, absent: kind === "sid-missing",
      hash: kind === "hash-mismatch" ? hashSessionToken(randomUUID()) : undefined, expired: kind === "db-expired", revoked: kind === "revoked" });
    expect(await checked(await request({ cookie }), 401)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
  it("rechecks logout and teaching rollout on the next request", async () => {
    const issued = await runtime.sessions.issue({ userId: f.scope.ownerUserId, workspaceId: f.scope.workspaceId });
    const cookie = `aistudy_session=${issued.token}`;
    await checked(await request({ cookie }), 200);
    await runtime.sessions.revoke(issued.principal.sessionId);
    await checked(await request({ cookie }), 401);
    vi.stubEnv("OPENING_TEACHING_LOOP", "0");
    try { await checked(await request(), 404); } finally { vi.stubEnv("OPENING_TEACHING_LOOP", "1"); }
  });
  it("isolates A/B activities and attempts in both directions without revealing existence", async () => {
    for (const input of [
      { id: other.session.activityId }, { cookie: otherCookie },
      { body: { attemptId: other.attempt.id, expectedRevision: own.session.revision, optIn: true } },
      { cookie: otherCookie, id: other.session.activityId, body: { attemptId: own.attempt.id, expectedRevision: other.session.revision, optIn: true } },
    ]) {
      const body = await checked(await request(input), 404);
      for (const value of [own.attempt.id, other.attempt.id, own.sourceId, other.sourceId]) expect(JSON.stringify(body)).not.toContain(value);
    }
    expect(await checked(await request({ cookie: otherCookie, id: other.session.activityId,
      body: { attemptId: other.attempt.id, expectedRevision: other.session.revision, optIn: true } }), 200)).toMatchObject({ experimentState: "off" });
  });
  it("rejects stale revision rather than selecting another anchor", async () => {
    await checked(await request({ body: { attemptId: own.attempt.id, expectedRevision: own.session.revision + 1, optIn: false } }), 409);
  });
  it.each(["ownerUserId", "workspaceId", "trustedHost", "enabled", "cutoff", "family", "ruleInput", "grant"])("rejects injected %s", async key => {
    await checked(await request({ body: { attemptId: own.attempt.id, expectedRevision: own.session.revision, optIn: true, [key]: true } }), 400);
  });
  it.each<NonNullable<Parameters<typeof request>[0]>>([
    { headers: { origin: "https://foreign.invalid" } }, { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { "content-type": "text/plain" } }, { headers: { "content-encoding": "gzip" } },
    { headers: { "content-length": "4097" } }, { raw: " ".repeat(4097) }, { raw: "{" },
    { id: "not-a-uuid" }, { body: { attemptId: "invalid", expectedRevision: 1, optIn: true } },
    { body: { attemptId: randomUUID(), expectedRevision: 1 } },
  ])("rejects strict same-origin bounded input %#", async input => { await checked(await request(input), 400); });

  it.each([
    "legacy-null", "owner-null", "course-null", "direct", "owner-only-ambiguous", "same-course-session",
    "foreign-owner", "foreign-workspace", "foreign-session-owner", "foreign-session-workspace",
    "foreign-session-explicit-course", "other-course-session", "direct-other-course", "direct-foreign-owner",
    "legacy-language", "legacy-math", "undelivered",
  ])("scopes delivered help conservatively: %s", async kind => {
    expect(await checked(await request(), 200)).toMatchObject({ messageCode: "rule_only" });
    const id = randomUUID();
    let workspaceId = f.scope.workspaceId, ownerUserId: string | null = null;
    let courseId: string | null = null, sessionId: string | null = own.session.sessionId;
    let extraSessionId: string | null = null;
    if (["owner-null", "direct", "direct-other-course", "direct-foreign-owner", "foreign-session-explicit-course"].includes(kind)) courseId = own.courseId;
    if (["course-null", "direct", "owner-only-ambiguous", "direct-other-course"].includes(kind)) ownerUserId = f.scope.ownerUserId;
    if (["direct", "owner-only-ambiguous", "direct-other-course", "direct-foreign-owner"].includes(kind)) sessionId = null;
    if (["foreign-owner", "direct-foreign-owner"].includes(kind)) ownerUserId = f.otherScope.ownerUserId;
    if (kind === "foreign-workspace") workspaceId = f.otherScope.workspaceId;
    if (kind === "foreign-session-explicit-course") sessionId = other.session.sessionId;
    if (kind === "direct-other-course") courseId = other.courseId;
    if (["same-course-session", "foreign-session-owner", "foreign-session-workspace", "other-course-session"].includes(kind)) {
      extraSessionId = randomUUID(); sessionId = extraSessionId;
      await f.sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,skill_label,source_ids,activity_id)
        SELECT ${extraSessionId},${kind === "foreign-session-workspace" ? f.otherScope.workspaceId : f.scope.workspaceId},
          ${kind === "foreign-session-owner" ? f.otherScope.ownerUserId : f.scope.ownerUserId},
          ${kind === "other-course-session" ? other.courseId : own.courseId},skill_label,source_ids,activity_id
        FROM opening_learning_sessions WHERE id=${own.session.sessionId}`;
    }
    try {
      await f.sql`INSERT INTO opening_help_exposures(id,workspace_id,owner_user_id,course_id,session_id,turn_id,
          level,delivered,kind,delivered_at,support_domain,release_key)
        VALUES(${id},${workspaceId},${ownerUserId},${courseId},${sessionId},${randomUUID()},'revealed',${kind !== "undelivered"},
          'instruction',${kind === "undelivered" ? null : new Date()},
          ${kind === "legacy-language" ? "language" : kind === "legacy-math" ? "math" : "unknown"},
          ${kind === "undelivered" ? randomUUID() : null})`;
      const receipt = () => f.sql`SELECT * FROM opening_help_exposures WHERE id=${id}`;
      const before = await receipt();
      if (kind === "legacy-null") {
        const [bound] = await f.sql`SELECT h.owner_user_id,h.course_id,s.owner_user_id AS resolved_owner,s.course_id AS resolved_course
          FROM opening_help_exposures h JOIN opening_learning_sessions s ON s.id=h.session_id AND s.workspace_id=h.workspace_id
          WHERE h.id=${id}`;
        expect(bound).toEqual({ owner_user_id: null, course_id: null, resolved_owner: f.scope.ownerUserId, resolved_course: own.courseId });
      }
      const unavailable = ["legacy-null", "owner-null", "course-null", "direct", "owner-only-ambiguous", "same-course-session", "legacy-math"].includes(kind);
      const body = await checked(await request(), 200);
      if (unavailable) expect(body).toEqual({ advice: null, experimentState: "off", messageCode: "advice_unavailable" });
      else expect(body).toMatchObject({ messageCode: "rule_only", experimentState: "off", advice: { status: "disabled", experimentalAdvice: null } });
      expect(await receipt()).toEqual(before);
    } finally {
      await f.sql`DELETE FROM opening_help_exposures WHERE id=${id}`;
      if (extraSessionId) await f.sql`DELETE FROM opening_learning_sessions WHERE id=${extraSessionId}`;
    }
    expect(await checked(await request(), 200)).toMatchObject({ messageCode: "rule_only" });
  });

  // Every SQL negative control is rolled back after the real handler sees it through its own connection.
  async function mutation(change: () => Promise<unknown>, restore: () => Promise<unknown>, status: number, unavailable = false) {
    await change();
    try {
      const body = await checked(await request(), status);
      if (unavailable) expect(body).toEqual({ advice: null, experimentState: "off", messageCode: "advice_unavailable" });
    } finally { await restore(); }
    expect(await checked(await request(), 200)).toMatchObject({ messageCode: "rule_only" });
  }
  it("requires exact activity-session binding", async () => {
    const [row] = await f.sql`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${own.session.activityId}`;
    await mutation(() => f.sql`UPDATE opening_teaching_activities SET checkpoint_json=jsonb_set(checkpoint_json,'{spanLesson,sessionId}',${JSON.stringify(other.session.sessionId)}::jsonb) WHERE id=${own.session.activityId}`,
      () => f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json(row!.checkpoint_json)} WHERE id=${own.session.activityId}`, 404);
  });
  it("requires exact attempt course", async () => {
    await mutation(() => f.sql`UPDATE opening_learning_attempts SET course_id=${other.courseId} WHERE id=${own.attempt.id}`,
      () => f.sql`UPDATE opening_learning_attempts SET course_id=${own.courseId} WHERE id=${own.attempt.id}`, 404);
  });
  it("rejects a same-workspace activity owned by another user", async () => {
    await mutation(() => f.sql`UPDATE opening_teaching_activities SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${own.session.activityId}`,
      () => f.sql`UPDATE opening_teaching_activities SET owner_user_id=${f.scope.ownerUserId} WHERE id=${own.session.activityId}`, 404);
  });
  it("requires exact attempt session", async () => {
    await mutation(() => f.sql`UPDATE opening_learning_attempts SET session_id=${other.session.sessionId} WHERE id=${own.attempt.id}`,
      () => f.sql`UPDATE opening_learning_attempts SET session_id=${own.session.sessionId} WHERE id=${own.attempt.id}`, 404);
  });
  it("requires exact attempt activity", async () => {
    await mutation(() => f.sql`UPDATE opening_learning_attempts SET activity_id=${other.session.activityId} WHERE id=${own.attempt.id}`,
      () => f.sql`UPDATE opening_learning_attempts SET activity_id=${own.session.activityId} WHERE id=${own.attempt.id}`, 404);
  });
  it("requires exact item version identity", async () => {
    await mutation(() => f.sql`UPDATE opening_learning_attempts SET item_version_id=${other.attempt.itemVersionId} WHERE id=${own.attempt.id}`,
      () => f.sql`UPDATE opening_learning_attempts SET item_version_id=${own.attempt.itemVersionId} WHERE id=${own.attempt.id}`, 409);
  });
  it("requires active current course", async () => {
    await mutation(() => f.sql`UPDATE courses SET archived_at=now() WHERE id=${own.courseId}`,
      () => f.sql`UPDATE courses SET archived_at=NULL WHERE id=${own.courseId}`, 404);
  });
  it("requires current requirement revision", async () => {
    await mutation(() => f.sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${own.requirementId}`,
      () => f.sql`UPDATE course_requirements SET revision=revision-1 WHERE id=${own.requirementId}`, 409);
  });
  it("requires current goal lifecycle", async () => {
    await mutation(() => f.sql`UPDATE course_goals SET lifecycle='paused' WHERE id=${own.goalId}`,
      () => f.sql`UPDATE course_goals SET lifecycle='active' WHERE id=${own.goalId}`, 409);
  });
  it("requires current source membership", async () => {
    const [row] = await f.sql`SELECT * FROM course_asset_memberships WHERE course_id=${own.courseId} AND asset_id=${own.sourceId}`;
    await mutation(() => f.sql`DELETE FROM course_asset_memberships WHERE course_id=${own.courseId} AND asset_id=${own.sourceId}`,
      () => f.sql`INSERT INTO course_asset_memberships ${f.sql(row!)}`, 409);
  });
  it("requires teaching purpose", async () => {
    await mutation(() => f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${own.courseId} AND asset_id=${own.sourceId}`,
      () => f.sql`UPDATE course_asset_memberships SET purpose=NULL WHERE course_id=${own.courseId} AND asset_id=${own.sourceId}`, 409);
  });
  it("requires current source version", async () => {
    await mutation(() => f.sql`UPDATE opening_sources SET version=2 WHERE id=${own.sourceId}`,
      () => f.sql`UPDATE opening_sources SET version=1 WHERE id=${own.sourceId}`, 409);
  });
  it("requires current privacy permission", async () => {
    const id = randomUUID();
    await mutation(() => f.sql`INSERT INTO opening_privacy_exclusions(id,workspace_id,source_id) VALUES(${id},${f.scope.workspaceId},${own.sourceId})`,
      () => f.sql`DELETE FROM opening_privacy_exclusions WHERE id=${id}`, 409);
  });
  it.each(["paused", "completed"])("keeps unsupported %s activity unavailable", async status => {
    await mutation(() => f.sql`UPDATE opening_teaching_activities SET status=${status} WHERE id=${own.session.activityId}`,
      () => f.sql`UPDATE opening_teaching_activities SET status='active' WHERE id=${own.session.activityId}`, 200, true);
  });
  it("does not guess missing persisted retest fact", async () => {
    const [row] = await f.sql`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${own.session.activityId}`;
    await mutation(() => f.sql`UPDATE opening_teaching_activities SET checkpoint_json=checkpoint_json #- '{spanLesson,retestId}' WHERE id=${own.session.activityId}`,
      () => f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json(row!.checkpoint_json)} WHERE id=${own.session.activityId}`, 200, true);
  });
});
