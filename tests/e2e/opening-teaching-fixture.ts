import { createHash, randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import postgres from "postgres";

function fixtureSql() {
  const raw = process.env.E2E_DATABASE_URL;
  if (!raw) throw new Error("Teaching fixtures require E2E_DATABASE_URL");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !decodeURIComponent(url.pathname).endsWith("_e2e") || url.search || url.hash) {
    throw new Error("Teaching fixtures may only access a loopback PostgreSQL database ending in _e2e, without query overrides");
  }
  return postgres(raw, { max: 1, connect_timeout: 8 });
}

/**
 * Real course API plus an explicitly pre-parsed source fixture. This exercises
 * owned course membership and canonical item versions, not PDF/object parsing.
 * Answers, activities, hints, and tasks must all be created through the app API.
 */
export async function createTeachingCourse(request: APIRequestContext, origin: string) {
  const courseResponse = await request.post("/api/courses", {
    headers: { origin }, data: { title: "Span 完整流程验收", slug: `span-e2e-${randomUUID()}`, description: "隔离测试；材料预置为 ready，不代表 PDF 解析验收。" },
  });
  if (courseResponse.status() !== 201) throw new Error(`Course fixture failed: ${courseResponse.status()} ${await courseResponse.text()}`);
  const courseId = (await courseResponse.json() as { course: { id: string } }).course.id;
  const preferences = await request.put("/api/workspace/preferences", { headers: { origin }, data: {
    learningPreferences: { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false },
  } });
  if (!preferences.ok()) throw new Error(`Learning preferences failed: ${preferences.status()} ${await preferences.text()}`);
  const sourceId = randomUUID(), text = "E2E pre-parsed source: write alpha v + beta w = u and check every coordinate.";
  const sql = fixtureSql();
  try {
    const [course] = await sql`SELECT c.workspace_id,w.owner_user_id FROM courses c JOIN workspaces w ON w.id=c.workspace_id
      JOIN users u ON u.id=w.owner_user_id WHERE c.id=${courseId} AND u.email='opening-e2e-owner@example.com'`;
    if (!course) throw new Error("Course fixture is not owned by the isolated Opening owner");
    const workspaceId = String(course.workspace_id), ownerUserId = String(course.owner_user_id);
    await sql.begin(async tx => {
      await tx`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
        VALUES (${sourceId},${workspaceId},'span-e2e-ready.txt','text/plain',${Buffer.byteLength(text)},${createHash("sha256").update(text).digest("hex")},1,'uploaded','ready')`;
      await tx`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
        VALUES (${randomUUID()},${sourceId},1,1,${text})`;
      await tx`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
        VALUES (${workspaceId},${courseId},'source',${sourceId},'core','course')`;
    });
    return { courseId, sourceId, workspaceId, ownerUserId };
  } finally { await sql.end({ timeout: 5 }); }
}

export type TeachingCourse = Awaited<ReturnType<typeof createTeachingCourse>>;

export async function readTeachingEvidence(course: TeachingCourse, attemptId: string) {
  const sql = fixtureSql();
  try {
    const attempts = await sql`SELECT id,session_id,activity_id,problem_id,item_version_id,submitted_at,observation_id
      FROM opening_learning_attempts WHERE id=${attemptId} AND course_id=${course.courseId}
        AND workspace_id=${course.workspaceId} AND owner_user_id=${course.ownerUserId}`;
    const observations = await sql`SELECT id,answer,assistance,outcome FROM opening_learning_observations
      WHERE attempt_id=${attemptId} AND workspace_id=${course.workspaceId} AND owner_user_id=${course.ownerUserId} ORDER BY recorded_at,id`;
    const exposures = await sql`SELECT id,release_key,level FROM opening_help_exposures WHERE attempt_id=${attemptId}
      AND workspace_id=${course.workspaceId} AND owner_user_id=${course.ownerUserId}
      AND delivered=TRUE AND released_at IS NOT NULL ORDER BY release_key`;
    return { attempt: attempts[0] ?? null, observations: [...observations], exposures: [...exposures] };
  } finally { await sql.end({ timeout: 5 }); }
}

/** Test the time gate deterministically. This is not elapsed-time learning evidence. */
export async function makeTeachingRetestDue(course: TeachingCourse, candidateId: string) {
  const sql = fixtureSql();
  try {
    const changed = await sql`UPDATE opening_retest_activities SET not_before_at=now()-interval '1 minute',
      recommended_at=now()-interval '1 minute',scheduled_start_at=now()-interval '1 minute'
      WHERE candidate_id=${candidateId} AND course_id=${course.courseId} AND workspace_id=${course.workspaceId}
        AND owner_user_id=${course.ownerUserId} AND status IN ('accepted','in_progress') RETURNING id`;
    if (changed.length !== 1) throw new Error("Expected exactly one owned accepted retest fixture");
  } finally { await sql.end({ timeout: 5 }); }
}

export async function readTeachingRetest(course: TeachingCourse, candidateId: string) {
  const sql = fixtureSql();
  try {
    const rows = await sql`SELECT r.status,r.result,t.status AS task_status FROM opening_retest_activities r
      JOIN opening_tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
      WHERE r.candidate_id=${candidateId} AND r.course_id=${course.courseId}
        AND r.workspace_id=${course.workspaceId} AND r.owner_user_id=${course.ownerUserId}`;
    return rows[0] ?? null;
  } finally { await sql.end({ timeout: 5 }); }
}
