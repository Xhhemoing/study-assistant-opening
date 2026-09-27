import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "@aistudy/database";
import { createOpeningFixture } from "./opening-fixture";

export const sourceBytes = Buffer.from("Q03 real backup source\n", "utf8");
export const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

export function backupRows(sql: Sql, scope: OpeningScope) {
  const { workspaceId: w, ownerUserId: u } = scope;
  const courseId = randomUUID();
  return {
    async source(state = "uploaded", version = 1) {
      const id = randomUUID();
      await sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
        VALUES (${id}, ${w}, 'backup.txt', 'text/plain', ${sourceBytes.length}, ${sourceHash}, ${version}, ${state}, 'ready')`;
      return id;
    },
    async chunk(source: string, version = 1) {
      const id = randomUUID();
      await sql`INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
        VALUES (${id}, ${source}, ${version}, 1, 'source evidence', 'private/locator')`;
      return id;
    },
    async conversation() {
      const id = randomUUID();
      await sql`INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
        VALUES (${id}, ${w}, ${u}, 'Backup conversation')`;
      return id;
    },
    async turn(conversation: string, sources: string[] = []) {
      const id = randomUUID();
      const versions = Object.fromEntries(sources.map((source) => [source, 1]));
      await sql`INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status, source_ids, source_versions)
        VALUES (${id}, ${w}, ${conversation}, 'assistant', 'saved answer', 'hint', 'complete', ${sources}, ${sql.json(versions)})`;
      return id;
    },
    async learning(sources: string[] = []) {
      const id = randomUUID();
      await sql`INSERT INTO opening_learning_sessions (id, workspace_id, owner_user_id, course_id, skill_label, source_ids)
        VALUES (${id}, ${w}, ${u}, ${courseId}, 'Recall', ${sources})`;
      return id;
    },
    async problem(session: string, source: string, chunk: string | null = null) {
      const id = randomUUID();
      await sql`INSERT INTO opening_problem_refs (problem_id, workspace_id, session_id, source_id, source_version, chunk_id, stem_snapshot, artifact_kind)
        VALUES (${id}, ${w}, ${session}, ${source}, 1, ${chunk}, 'Question', 'reference_item')`;
      return id;
    },
    async help(session: string, turn: string, problem: string | null = null) {
      const id = randomUUID();
      await sql`INSERT INTO opening_help_exposures (id, workspace_id, session_id, problem_id, turn_id, level, delivered)
        VALUES (${id}, ${w}, ${session}, ${problem}, ${turn}, 'hinted', true)`;
      return id;
    },
    async observation(session: string, sources: string[] = [], turns: string[] = [], problem: string | null = null) {
      const id = randomUUID();
      await sql`INSERT INTO opening_learning_observations
        (id, workspace_id, owner_user_id, session_id, course_id, skill_label, source_ids, problem_id, answer, outcome, assistance, client_key, source_turn_ids, verdict_source)
        VALUES (${id}, ${w}, ${u}, ${session}, ${courseId}, 'Recall', ${sources}, ${problem}, 'Answer', 'unverified', 'unknown', ${id}, ${turns}, 'unknown')`;
      return id;
    },
    async candidate(conversation: string, turn: string, sources: string[] = []) {
      const id = randomUUID();
      await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
        VALUES (${id}, ${w}, ${conversation}, ${turn}, ${sql.json(sources)}, '{}'::jsonb)`;
      return id;
    },
    async memory(turns: string[] = [], status = "active") {
      const id = randomUUID();
      await sql`INSERT INTO opening_memories (id, workspace_id, kind, text, source_turn_ids, status)
        VALUES (${id}, ${w}, 'confirmed', 'Saved memory', ${sql.json(turns)}, ${status})`;
      return id;
    },
    async exclude(source: string, memory: string | null = null) {
      await sql`INSERT INTO opening_privacy_exclusions (workspace_id, source_id, memory_id, deleted_at)
        VALUES (${w}, ${source}, ${memory}, '2026-09-25T00:00:00Z')`;
      await sql`UPDATE workspaces SET privacy_epoch = privacy_epoch + 1 WHERE id = ${w}`;
    },
  };
}

export async function seedBackupPlanning(sql: Sql, scope: OpeningScope) {
  const { workspaceId: w, ownerUserId: u } = scope;
  const task = randomUUID(), timetable = randomUUID(), hard = randomUUID(), draft = randomUUID();
  await sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes)
    VALUES (${task}, ${w}, ${u}, 'Review', 30)`;
  await sql`INSERT INTO opening_timetable_sessions (id, workspace_id, owner_user_id, course_name, weekday, weeks, start_period, end_period)
    VALUES (${timetable}, ${w}, ${u}, 'Math', 1, ARRAY[1,2], 1, 2)`;
  await sql`INSERT INTO opening_hard_blocks (id, workspace_id, owner_user_id, day, start_at, end_at, kind)
    VALUES (${hard}, ${w}, ${u}, '2026-09-25', '2026-09-25T01:00Z', '2026-09-25T02:00Z', 'class')`;
  await sql`INSERT INTO opening_plan_state (workspace_id, day) VALUES (${w}, '2026-09-25') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO opening_plan_drafts (id, workspace_id, owner_user_id, day, base_version, input_snapshot, hard_blocks_fingerprint)
    VALUES (${draft}, ${w}, ${u}, '2026-09-25', 0, '{}'::jsonb, 'fingerprint')`;
  await sql`INSERT INTO opening_plan_acceptances (workspace_id, client_key, draft_id, day, accepted_version, payload_hash)
    VALUES (${w}, ${draft}, ${draft}, '2026-09-25', 1, 'hash')`;
  return { task, timetable, hard, draft };
}

export async function seedBackupGraph(sql: Sql, scope: OpeningScope) {
  const row = backupRows(sql, scope);
  const source = await row.source(), conversation = await row.conversation();
  const chunk = await row.chunk(source), session = await row.learning([source]);
  const turn = await row.turn(conversation, [source]);
  await sql`UPDATE opening_turns SET chunk_id = ${chunk}, learning_session_id = ${session} WHERE id = ${turn}`;
  const problem = await row.problem(session, source, chunk);
  const help = await row.help(session, turn, problem);
  const observation = await row.observation(session, [source], [turn], problem);
  const candidate = await row.candidate(conversation, turn, [source]);
  const memory = await row.memory([turn]);
  await row.exclude(randomUUID());
  return { source, chunk, conversation, session, turn, problem, help, observation, candidate, memory,
    ...await seedBackupPlanning(sql, scope) };
}

export async function createBackupFixture() {
  const fixture = await createOpeningFixture();
  return { ...fixture, rows: backupRows(fixture.sql, fixture.scope), async dispose() {
    try {
      const workspaces = [fixture.scope.workspaceId, fixture.otherScope.workspaceId];
      const users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
      await fixture.sql`DELETE FROM opening_learning_sessions WHERE workspace_id IN ${fixture.sql(workspaces)}`;
      await fixture.sql`DELETE FROM workspaces WHERE id IN ${fixture.sql(workspaces)}`;
      await fixture.sql`DELETE FROM sessions WHERE user_id IN ${fixture.sql(users)}`;
      await fixture.sql`DELETE FROM users WHERE id IN ${fixture.sql(users)}`;
    } finally { await fixture.close(); }
  } };
}
export type BackupFixture = Awaited<ReturnType<typeof createBackupFixture>>;
