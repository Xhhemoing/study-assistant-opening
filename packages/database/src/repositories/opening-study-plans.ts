import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { readPlanSlot, type TaskPlanSlot } from "./opening-task-fields";

export type { TaskPlanSlot };

export type StudyPlanTaskRow = { id: string; status: "pending" | "done" | "skipped"; slot: TaskPlanSlot };
export type StudyPlanTaskInput = { clientKey: string; title: string; minutes: number; priority: number; slot: TaskPlanSlot };
export type StudyPlanMistake = { question: string; chunkIds: string[] };

function lockKeys(scope: OpeningScope, courseId: string): [number, number] {
  const digest = createHash("sha256").update(`opening-study-plan:${scope.workspaceId}:${scope.ownerUserId}:${courseId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function chunkIdsOf(refs: unknown): string[] {
  return Array.isArray(refs)
    ? refs.flatMap((ref) => (ref && typeof ref === "object" && typeof (ref as { chunkId?: unknown }).chunkId === "string" ? [(ref as { chunkId: string }).chunkId] : []))
    : [];
}

/**
 * Course study plans (0065): planner-made tasks carry the lesson they stand for in
 * `plan_slot`; progress is read back from completed lessons, not from the tasks.
 */
export function createOpeningStudyPlansRepository(sql: Sql) {
  async function listPlanTasks(scope: OpeningScope, courseId: string): Promise<StudyPlanTaskRow[]> {
    const rows = await sql`SELECT id, status, plan_slot FROM opening_tasks
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND course_id=${courseId} AND plan_slot IS NOT NULL
      ORDER BY created_at, id`;
    return rows.flatMap((row) => {
      const slot = readPlanSlot(row.plan_slot);
      return slot ? [{ id: String(row.id), status: row.status as StudyPlanTaskRow["status"], slot }] : [];
    });
  }

  return {
    listPlanTasks,

    /**
     * Issues one day's plan tasks exactly once per course and day: under a per-course
     * lock, does nothing when that day already has plan tasks (done or not), so
     * finishing them never makes the planner add more. Returns how many were added.
     */
    async issueDay(
      scope: OpeningScope,
      courseId: string,
      localDate: string,
      build: (existing: StudyPlanTaskRow[]) => Promise<StudyPlanTaskInput[]>,
    ): Promise<number> {
      return sql.begin(async (tx) => {
        const [a, b] = lockKeys(scope, courseId);
        await tx`SELECT pg_advisory_xact_lock(${a}::int, ${b}::int)`;
        const course = await tx`SELECT 1 FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL`;
        if (!course.length) return 0;
        const existing = await listPlanTasks(scope, courseId);
        if (existing.some((task) => task.slot.localDate === localDate)) return 0;
        const inputs = await build(existing);
        let added = 0;
        for (const input of inputs) {
          const rows = await tx`INSERT INTO opening_tasks (
              id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version,
              client_key, course_id, origin, plan_slot
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title.slice(0, 240)}, ${input.minutes},
              ${null}, ${input.priority}, 'pending', 1, ${input.clientKey}, ${courseId}, 'planner', ${tx.json(input.slot as never)}
            ) ON CONFLICT (workspace_id, owner_user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
            RETURNING id`;
          added += rows.length;
        }
        return added;
      });
    },

    /** Chunk → local days (in `timeZone`) on which a completed lesson of this course cited it. */
    async taughtDaysByChunk(scope: OpeningScope, courseId: string, timeZone: string): Promise<Map<string, string[]>> {
      const rows = await sql`SELECT s.source_refs,
          to_char((a.updated_at AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS day
        FROM opening_teaching_activities a
        JOIN opening_teaching_activity_specs s ON s.activity_id=a.id
          AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
        WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
          AND a.course_id=${courseId} AND a.status='completed'`;
      const days = new Map<string, Set<string>>();
      for (const row of rows) {
        for (const chunkId of chunkIdsOf(row.source_refs)) {
          const set = days.get(chunkId) ?? new Set<string>();
          set.add(String(row.day));
          days.set(chunkId, set);
        }
      }
      return new Map([...days].map(([chunkId, set]) => [chunkId, [...set].sort()]));
    },

    /**
     * Questions answered wrong (current revision) in this course's lessons since the
     * last completed plan review began — the review that follows should revisit them.
     */
    async openMistakes(scope: OpeningScope, courseId: string, limit = 5): Promise<StudyPlanMistake[]> {
      const rows = await sql`
        WITH last_review AS (
          SELECT max(a.created_at) AS at FROM opening_teaching_activities a
          JOIN opening_tasks t ON t.id::text = a.create_intent->>'taskId'
            AND t.workspace_id=a.workspace_id AND t.owner_user_id=a.owner_user_id
          WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
            AND a.course_id=${courseId} AND a.status='completed' AND t.plan_slot->>'kind'='review'
        )
        SELECT COALESCE(p.stem_snapshot, att.skill_label) AS question, s.source_refs, att.started_at,
          lb.content->'citedChunkIds' AS question_chunk_ids
        FROM opening_learning_attempts att
        JOIN opening_teaching_activities a ON a.id=att.activity_id
          AND a.workspace_id=att.workspace_id AND a.owner_user_id=att.owner_user_id
        JOIN opening_learning_observations root ON root.id=att.observation_id
          AND root.workspace_id=att.workspace_id AND root.owner_user_id=att.owner_user_id
        JOIN opening_learning_observations head ON head.id=COALESCE(root.effective_head_id, root.id)
          AND head.workspace_id=att.workspace_id AND head.owner_user_id=att.owner_user_id
          AND head.revision_kind <> 'retract'
        LEFT JOIN opening_problem_refs p ON p.problem_id=att.problem_id AND p.workspace_id=att.workspace_id
        LEFT JOIN opening_teaching_activity_specs s ON s.activity_id=a.id
          AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
        LEFT JOIN library_blocks lb ON lb.workspace_id=att.workspace_id
          AND lb.id::text = att.create_intent->'teachingBlock'->>'blockId'
        WHERE att.workspace_id=${scope.workspaceId} AND att.owner_user_id=${scope.ownerUserId}
          AND a.course_id=${courseId} AND head.outcome='incorrect'
          AND att.started_at > COALESCE((SELECT at FROM last_review), '-infinity'::timestamptz)
        ORDER BY att.started_at DESC, att.id DESC`;
      const seen = new Set<string>();
      const mistakes: StudyPlanMistake[] = [];
      for (const row of rows) {
        const question = String(row.question ?? "").slice(0, 300);
        if (!question || seen.has(question)) continue;
        seen.add(question);
        // The question's own cited pages when the lesson recorded them, else the lesson's.
        const cited = Array.isArray(row.question_chunk_ids) ? (row.question_chunk_ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
        mistakes.push({ question, chunkIds: cited.length ? cited : chunkIdsOf(row.source_refs) });
        if (mistakes.length >= limit) break;
      }
      return mistakes.reverse();
    },

    /**
     * The plan slot behind a lesson: set only for the first lesson of a plan task's
     * chain (「再学一节」 after it walks on from there). Scope-checked.
     */
    async activityPlanSlot(scope: OpeningScope, activityId: string): Promise<TaskPlanSlot | null> {
      const rows = await sql`SELECT t.plan_slot FROM opening_teaching_activities a
        JOIN opening_tasks t ON t.id::text = a.create_intent->>'taskId'
          AND t.workspace_id=a.workspace_id AND t.owner_user_id=a.owner_user_id
        WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
          AND NOT (a.create_intent ? 'continuesActivityId')`;
      return readPlanSlot(rows[0]?.plan_slot);
    },

    async courseTitle(scope: OpeningScope, courseId: string): Promise<string | null> {
      const rows = await sql`SELECT title FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL`;
      return rows[0] ? String(rows[0].title) : null;
    },
  };
}

export type OpeningStudyPlansRepository = ReturnType<typeof createOpeningStudyPlansRepository>;
