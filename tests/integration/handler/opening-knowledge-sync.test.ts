import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { uuidSchema } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET } from "../../../apps/web/src/app/api/opening/courses/[id]/knowledge/route";

// Exact pre-upgrade legacy .strict() sync schema (only the original 6 fields).
const legacyStrictSyncSchema = z.object({
  status: z.enum(["empty", "pending", "up_to_date", "needs_rebuild"]),
  activeJobId: uuidSchema.nullable(),
  lastBuiltVersion: z.number().int().min(0).nullable(),
  coveredSourceVersions: z.record(uuidSchema, z.number().int().min(0)),
  eligibleSourceVersions: z.record(uuidSchema, z.number().int().min(0)),
  parsingSourceCount: z.number().int().min(0),
}).strict();

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  vi.stubEnv("OPENING_TEACHING_LOOP", "1");
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  vi.unstubAllEnvs();
  if (f) {
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM users WHERE id IN (${f.scope.ownerUserId}, ${f.otherScope.ownerUserId})`;
  }
  await runtime?.close();
  await f?.close();
});

beforeEach(async () => {
  for (const wsId of [f.scope.workspaceId, f.otherScope.workspaceId]) {
    await f.sql`DELETE FROM opening_outbox WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM opening_jobs WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM opening_knowledge_confirmations WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM opening_course_knowledge WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM course_asset_memberships WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM courses WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM opening_source_versions WHERE workspace_id = ${wsId}`;
    await f.sql`DELETE FROM opening_sources WHERE workspace_id = ${wsId}`;
  }
});

async function seedCourse(scope = f.scope) {
  const courseId = randomUUID();
  await f.sql`
    INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${scope.workspaceId}, 'Negotiation Course', ${courseId})`;
  return courseId;
}

async function seedFailedSource(courseId: string, scope = f.scope) {
  const sourceId = randomUUID();
  const bytes = Buffer.from("scan", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await f.sql`
    INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${scope.workspaceId}, 'scan.pdf', 'application/pdf', ${bytes.length}, ${sha256}, 1, 'uploaded', 'failed')`;
  await f.sql`
    INSERT INTO opening_source_versions (source_id, version, workspace_id, bytes, sha256, availability)
    VALUES (${sourceId}, 1, ${scope.workspaceId}, ${bytes.length}, ${sha256}, 'available')`;
  await f.sql`
    INSERT INTO course_asset_memberships (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility, purpose)
    VALUES (${randomUUID()}, ${scope.workspaceId}, ${courseId}, 'source', ${sourceId}, 'core', 0, 'course', 'teaching')`;
  return sourceId;
}

async function seedJob(options: {
  scope?: typeof f.scope;
  courseId: string;
  kind?: string;
  state: "queued" | "running" | "succeeded" | "failed" | "outcome_unknown" | "cancelled";
  result?: Record<string, unknown> | null;
}) {
  const targetScope = options.scope ?? f.scope;
  const jobId = randomUUID();
  await f.sql`
    INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, result, state, privacy_epoch)
    VALUES (
      ${jobId},
      ${targetScope.workspaceId},
      ${targetScope.ownerUserId},
      ${`test-job:${jobId}`},
      ${options.kind ?? "build-course-knowledge"},
      ${f.sql.json({ courseId: options.courseId } as never)},
      ${options.result ? f.sql.json(options.result as never) : null},
      ${options.state},
      0
    )`;
  return jobId;
}

function getKnowledge(courseId: string, query = "", cookie = f.cookie) {
  const suffix = query ? `?${query}` : "";
  return GET(
    new Request(`http://localhost/api/opening/courses/${courseId}/knowledge${suffix}`, {
      method: "GET",
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ id: courseId }) },
  );
}

describe("GET /api/opening/courses/[id]/knowledge syncDetails negotiation and jobId scope (D6)", () => {
  it("requires authentication and enforces workspace/course ownership", async () => {
    const ownCourse = await seedCourse(f.scope);
    const foreignCourse = await seedCourse(f.otherScope);
    expect((await getKnowledge(ownCourse, "", "")).status).toBe(401);
    expect((await getKnowledge(foreignCourse, "syncDetails=1")).status).toBe(404);
  });

  it("keeps default no-param GET strictly compatible with legacy 6-field .strict() sync schema", async () => {
    const courseId = await seedCourse();
    await seedFailedSource(courseId);
    await seedJob({ courseId, state: "failed", result: { error: "sensitive stack trace" } });

    const legacyRes = await getKnowledge(courseId);
    expect(legacyRes.status).toBe(200);
    expect(legacyRes.headers.get("Cache-Control")).toBe("no-store");
    const legacyBody = await legacyRes.json();
    expect(legacyStrictSyncSchema.parse(legacyBody.sync)).toEqual({
      status: "empty",
      activeJobId: null,
      lastBuiltVersion: null,
      coveredSourceVersions: {},
      eligibleSourceVersions: {},
      parsingSourceCount: 0,
    });
    expect(Object.keys(legacyBody.sync).sort()).toEqual([
      "activeJobId",
      "coveredSourceVersions",
      "eligibleSourceVersions",
      "lastBuiltVersion",
      "parsingSourceCount",
      "status",
    ]);
  });

  it("returns explicit 4 extended syncDetails fields without error leakage and isolates requestedJob by course/owner/kind", async () => {
    const courseA = await seedCourse(f.scope);
    const courseB = await seedCourse(f.scope);
    const foreignCourse = await seedCourse(f.otherScope);

    // Clean course with syncDetails=1 returns explicit zeros/false/null
    const emptyDetailedRes = await getKnowledge(courseA, "syncDetails=1");
    expect(emptyDetailedRes.status).toBe(200);
    const emptyDetailed = await emptyDetailedRes.json();
    expect(emptyDetailed.sync).toEqual({
      status: "empty",
      activeJobId: null,
      lastBuiltVersion: null,
      coveredSourceVersions: {},
      eligibleSourceVersions: {},
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    });

    await seedFailedSource(courseA);
    const ownFailedJob = await seedJob({
      courseId: courseA,
      state: "outcome_unknown",
      result: { error: "secret provider error must never leak" },
    });
    const otherCourseJob = await seedJob({ courseId: courseB, state: "failed" });
    const otherKindJob = await seedJob({ courseId: courseA, kind: "parse", state: "failed" });
    const foreignOwnerJob = await seedJob({ scope: f.otherScope, courseId: foreignCourse, state: "failed" });

    // Own jobId resolves with exact state and zero error leakage
    const ownJobRes = await getKnowledge(courseA, `syncDetails=1&jobId=${ownFailedJob}`);
    expect(ownJobRes.status).toBe(200);
    const ownJobBody = await ownJobRes.json();
    expect(ownJobBody.sync.unreadableSourceCount).toBe(1);
    expect(ownJobBody.sync.rebuildBlockedByMaterials).toBe(false);
    expect(ownJobBody.sync.lastFailedJob).toEqual({ jobId: ownFailedJob, state: "outcome_unknown" });
    expect(ownJobBody.sync.requestedJob).toEqual({ jobId: ownFailedJob, state: "outcome_unknown" });
    expect("error" in ownJobBody.sync.lastFailedJob).toBe(false);

    // Cross-course, cross-kind, cross-owner, and missing UUID all return requestedJob: null
    for (const isolatedJobId of [otherCourseJob, otherKindJob, foreignOwnerJob, randomUUID()]) {
      const res = await getKnowledge(courseA, `syncDetails=1&jobId=${isolatedJobId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sync.requestedJob).toBeNull();
    }

    // Invalid jobId UUID returns 400 (with or without syncDetails=1)
    expect((await getKnowledge(courseA, "syncDetails=1&jobId=not-a-uuid")).status).toBe(400);
    expect((await getKnowledge(courseA, "jobId=not-a-uuid")).status).toBe(400);
  });
});
