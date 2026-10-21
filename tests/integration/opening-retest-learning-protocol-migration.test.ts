import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { getSpanProblem, spanProblemStem, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";

const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
const sql = createSqlClient(url.toString(), { max: 1 });
const schema = `span_protocol_upgrade_${randomUUID().replaceAll("-", "")}`;
const migrationsRoot = path.resolve(process.cwd(), "packages/database/src/migrations");
const migrationId = "0082_opening_retest_learning_protocol.sql", lockKey = 791_002_382;
const ownerId = randomUUID(), workspaceId = randomUUID(), courseId = randomUUID(), baselineId = randomUUID();
const submittedAt = "2026-10-20T00:00:00.000Z", notBeforeAt = "2026-10-23T00:00:00.000Z";
let migrationsDir: string;
let historicalIds: string[];

beforeAll(async () => {
  // Integration setup already installed these extensions. Refuse to create or
  // move a shared extension while constructing a private historical schema.
  const extensions = await sql`SELECT e.extname,n.nspname FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname IN ('pgcrypto','pg_trgm') ORDER BY e.extname`;
  expect(extensions).toEqual([{ extname: "pg_trgm", nspname: "public" }, { extname: "pgcrypto", nspname: "public" }]);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await sql`CREATE TABLE schema_migrations (id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text,verification_state text,recorded_at timestamptz)`;
  migrationsDir = await mkdtemp(path.join(tmpdir(), "span-protocol-migrations-"));
  historicalIds = (await readdir(migrationsRoot)).filter(id => /^\d{4}_.+\.sql$/.test(id) && Number(id.slice(0, 4)) <= 81).sort();
  expect(historicalIds).toHaveLength(81);
  for (const id of historicalIds) {
    const body = await readFile(path.join(migrationsRoot, id), "utf8");
    await copyFile(path.join(migrationsRoot, id), path.join(migrationsDir, id));
    await sql.begin(async tx => {
      // Every real historical DDL statement is unchanged. Only 0007 needs the
      // already-installed trigram opclass; all its indexed tables exist here.
      // No other migration can fall through to a public application table.
      if (id === "0007_search_indexes.sql") await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations(id,checksum,verification_state,recorded_at)
        VALUES (${id},${createHash("sha256").update(body).digest("hex")},'verified',now())`;
    });
    expect((await sql`SELECT current_schema() AS name`)[0]?.name).toBe(schema);
  }
  expect(await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema}
    AND table_name='opening_retest_activities' AND column_name IN ('learning_protocol','candidate_reference_id','accept_client_key')`).toEqual([]);
}, 120_000);

afterAll(async () => {
  try {
    await sql.unsafe("SET search_path TO public");
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await sql.end({ timeout: 5 });
    if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true });
  }
});

async function seedBaseline() {
  const sourceId = randomUUID(), lessonId = randomUUID(), sessionId = randomUUID(), problemId = randomUUID(), itemId = randomUUID(), attemptId = randomUUID();
  const problem = getSpanProblem("span-example-2d")!, stem = spanProblemStem(problem);
  const spec = { kind: "span", specVersion: "span-v1", problemId: problem.id, version: 1,
    familyId: problem.familyId, requirementKey: SPAN_REQUIREMENT_KEY, knowledgeComponents: problem.knowledgeComponents, transfer: null };
  const answer = JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"],
    equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] });
  await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES (${ownerId},${`${ownerId}@upgrade.example`},'Upgrade fixture','test')`;
  await sql`INSERT INTO workspaces(id,owner_user_id) VALUES (${workspaceId},${ownerId})`;
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${workspaceId},'Original course',${courseId})`;
  await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${sourceId},${workspaceId},'original.txt','text/plain',1,${"a".repeat(64)},1,'uploaded','ready')`;
  await sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,client_key,create_intent)
    VALUES (${lessonId},${workspaceId},${ownerId},${courseId},'paused','course_continue','Saved original lesson',${randomUUID()},'{}')`;
  await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
    VALUES (${sessionId},${workspaceId},${ownerId},${courseId},${lessonId},${SPAN_SKILL_LABEL},${[sourceId]})`;
  await sql`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,stem_snapshot,artifact_kind)
    VALUES (${problemId},${workspaceId},${sessionId},${sourceId},1,${stem},'reference_item')`;
  await sql`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,stem_snapshot,artifact_kind,evaluation_spec)
    VALUES (${itemId},${workspaceId},${ownerId},${courseId},${lessonId},${problemId},${sourceId},1,${stem},'reference_item',${sql.json(spec)})`;
  await sql`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,course_id,activity_id,session_id,skill_label,requirement_key,problem_id,item_version_id,
    source_ids,source_versions,started_at,submitted_at,observation_id,client_key,create_intent,history_revision)
    VALUES (${attemptId},${workspaceId},${ownerId},${courseId},${lessonId},${sessionId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${problemId},${itemId},
      ${[sourceId]},${sql.json({ [sourceId]: 1 })},${submittedAt},${submittedAt},${baselineId},${randomUUID()},
      ${sql.json({ sessionId, spanExercise: { sourceId, problemId: problem.id, version: 1 } })},1)`;
  await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES (${workspaceId},${ownerId},1)`;
  await sql`INSERT INTO opening_learning_observations(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,requirement_key,
    source_ids,source_versions,attempt_id,item_version_id,problem_id,root_observation_id,effective_head_id,answer,outcome,assistance,client_key,
    verdict_source,started_at,submitted_at,recorded_at,workspace_history_revision,server_evaluation)
    VALUES (${baselineId},${workspaceId},${ownerId},${sessionId},${courseId},${lessonId},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},
      ${[sourceId]},${sql.json({ [sourceId]: 1 })},${attemptId},${itemId},${problemId},${baselineId},${baselineId},${answer},'correct','hinted',${randomUUID()},
      'deterministic',${submittedAt},${submittedAt},${submittedAt},1,${sql.json({ evaluatorVersion: "span-exact-v1", decision: "correct" })})`;
}

it("upgrades real 0081 records without losing baseline facts or inventing missing protocols", async () => {
  await seedBaseline();
  const protocol = { protocolId: "span-delayed-3d-v1", baselineObservationId: baselineId,
    baselineRootId: baselineId, priorAnswerPolicy: "require_unseen_problem" };
  const cases = [];
  for (const kind of ["formal", "missing_baseline", "ordinary", "wrong_course"] as const) {
    const course = kind === "formal" ? courseId : randomUUID(), candidateId = randomUUID(), activityId = randomUUID(), taskId = randomUUID(), key = randomUUID();
    if (course !== courseId) await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${course},${workspaceId},${kind},${course})`;
    const payload = { id: candidateId, courseId: course, skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY,
      accepted: true, acceptClientKey: key, taskId, dueAt: notBeforeAt, notBeforeAt,
      ...(kind === "ordinary" ? {} : { spanDelayedProtocol: kind === "missing_baseline"
        ? { ...protocol, baselineObservationId: randomUUID() } : protocol }) };
    await sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES (${candidateId},${workspaceId},${ownerId},${candidateId},'retest',${sql.json(payload)},'succeeded')`;
    await sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,title,minutes,candidate_id,status,not_before)
      VALUES (${taskId},${workspaceId},${ownerId},${course},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},'Accepted old task',15,${candidateId},'pending',${notBeforeAt})`;
    await sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,requirement_key,evidence_cycle_id,
      candidate_id,task_id,status,accepted_at,not_before_at,recommended_at,version)
      VALUES (${activityId},${workspaceId},${ownerId},${course},${SPAN_SKILL_LABEL},${SPAN_REQUIREMENT_KEY},${randomUUID()},
        ${candidateId},${taskId},'accepted',${submittedAt},${notBeforeAt},${notBeforeAt},2)`;
    cases.push({ kind, candidateId, activityId, taskId, key });
  }
  const original = {
    observations: await sql`SELECT * FROM opening_learning_observations`, attempts: await sql`SELECT * FROM opening_learning_attempts`,
    items: await sql`SELECT * FROM opening_learning_item_versions`, tasks: await sql`SELECT * FROM opening_tasks ORDER BY id`,
    jobs: await sql`SELECT * FROM opening_jobs ORDER BY id`,
  };
  await copyFile(path.join(migrationsRoot, migrationId), path.join(migrationsDir, migrationId));
  expect(await applyMigrations(sql, { migrationsDir, advisoryLockKey: lockKey })).toEqual({ applied: [migrationId], alreadyApplied: historicalIds });
  for (const row of cases) {
    expect(await sql`SELECT candidate_id,candidate_reference_id,learning_protocol,accept_client_key,task_id,status,not_before_at,version
      FROM opening_retest_activities WHERE id=${row.activityId}`).toEqual([{
      candidate_id: row.candidateId, candidate_reference_id: row.candidateId, learning_protocol: row.kind === "formal" ? protocol : null,
      accept_client_key: row.kind === "formal" ? row.key : null, task_id: row.taskId, status: "accepted", not_before_at: new Date(notBeforeAt), version: 2,
    }]);
  }
  expect({ observations: await sql`SELECT * FROM opening_learning_observations`, attempts: await sql`SELECT * FROM opening_learning_attempts`,
    items: await sql`SELECT * FROM opening_learning_item_versions`, tasks: await sql`SELECT * FROM opening_tasks ORDER BY id`,
    jobs: await sql`SELECT * FROM opening_jobs ORDER BY id` }).toEqual(original);
  expect(await applyMigrations(sql, { migrationsDir, advisoryLockKey: lockKey })).toEqual({ applied: [], alreadyApplied: [...historicalIds, migrationId] });
  const formal = cases[0]!;
  await expect(sql`UPDATE opening_retest_activities SET accept_client_key=${formal.key} WHERE id=${cases[1]!.activityId}`)
    .rejects.toMatchObject({ code: "23505", constraint_name: "opening_retest_accept_client_key_uidx" });
  await sql`DELETE FROM opening_jobs WHERE id=${formal.candidateId}`;
  expect(await sql`SELECT candidate_id,candidate_reference_id,learning_protocol,accept_client_key,task_id FROM opening_retest_activities
    WHERE id=${formal.activityId}`).toEqual([{ candidate_id: null, candidate_reference_id: formal.candidateId,
    learning_protocol: protocol, accept_client_key: formal.key, task_id: formal.taskId }]);
}, 60_000);
