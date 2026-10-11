import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { HelpExposure, LearningObservation, LearningSessionCreateInput, ObservationInput, ObservationRevisionInput, ProblemRef, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, lockLearningOwner, lockLearningSession, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision, mapLearningObservation } from "./opening-learning-facts";
import { reviseOpeningLearningObservation, readOpeningObservationHistory } from "./opening-observation-revisions";
import { insertOpeningLearningObservation } from "./opening-learning-observations";
import { insertOpeningDeliveredHelp } from "./opening-learning-help";

/** All learning fact mutations use the native SQL transaction boundary. */
export function createOpeningLearningRepository(sql: Sql) {
  async function getSession(scope: Scope, id: string) {
    const rows = await sql`SELECT l.id,l.course_id,l.skill_label,l.source_ids FROM opening_learning_sessions l
      JOIN workspaces w ON w.id=l.workspace_id AND w.owner_user_id=${scope.ownerUserId}
      WHERE l.id=${id} AND l.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId}`;
    const row = rows[0];
    return row ? { id: String(row.id), courseId: String(row.course_id), skillLabel: String(row.skill_label), sourceIds: row.source_ids as string[] } : null;
  }
  return {
    getSession,
    reviseObservation: (scope: Scope, input: ObservationRevisionInput) => reviseOpeningLearningObservation(sql, scope, input),
    observationHistory: (scope: Scope, id: string) => readOpeningObservationHistory(sql, scope, id),
    async createSession(scope: Scope, input: LearningSessionCreateInput): Promise<{ id: string }> {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const course = await tx`SELECT id FROM courses WHERE id=${input.courseId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL FOR SHARE`;
        if (!course.length) throw learningError("NOT_FOUND", "course not found");
        await admitLearningSources(tx, scope, input.sourceIds);
        const clientKey = `legacy-course-continue:${input.courseId}`;
        const existing = await tx`
          SELECT id FROM opening_teaching_activities
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}
          FOR UPDATE`;
        let activityId = existing[0] ? String(existing[0].id) : randomUUID();
        if (!existing[0]) {
          const createIntent = { intentKind: "course_continue", courseId: input.courseId, legacy: true };
          const inserted = await tx`
            INSERT INTO opening_teaching_activities (
              id, workspace_id, owner_user_id, course_id, status, generate_status,
              intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
              checkpoint_json, client_key, create_intent
            ) VALUES (
              ${activityId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.courseId}, 'active', 'ready',
              'course_continue', 'Legacy course activity', ${[] as string[]}, ${tx.json({})},
              1, 0, ${tx.json({})}, ${clientKey}, ${tx.json(createIntent as never)}
            )
            ON CONFLICT (workspace_id, owner_user_id, client_key) DO NOTHING
            RETURNING id`;
          if (!inserted[0]) {
            const raced = await tx`
              SELECT id FROM opening_teaching_activities
              WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
            if (!raced[0]) throw learningError("CONFLICT", "course continue activity write conflict");
            activityId = String(raced[0].id);
          }
        }
        const id = randomUUID();
        await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
          VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${activityId},${input.skillLabel},${input.sourceIds})`;
        return { id };
      });
    },
    async assertOwnedCourse(scope: Scope, courseId: string): Promise<void> {
      const rows = await sql`SELECT c.id FROM courses c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.id=${courseId} AND c.workspace_id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND c.archived_at IS NULL`;
      if (!rows.length) throw learningError("NOT_FOUND", "course not found");
    },
    async upsertProblemRef(scope: Scope, ref: ProblemRef & { sessionId: string }): Promise<void> {
      await sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        const session = await lockLearningSession(tx, scope, ref.sessionId);
        if (!(session.source_ids as string[]).includes(ref.sourceId)) throw learningError("VALIDATION", "problem source is outside session");
        await admitLearningSources(tx, scope, [ref.sourceId]);
        const changed = await tx`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,physical_page,chunk_id,stem_snapshot,artifact_kind)
          VALUES (${ref.problemId},${scope.workspaceId},${ref.sessionId},${ref.sourceId},${ref.sourceVersion},${ref.physicalPage},${ref.chunkId},${ref.stemSnapshot},${ref.artifactKind})
          ON CONFLICT(problem_id) DO UPDATE SET source_id=EXCLUDED.source_id,source_version=EXCLUDED.source_version,physical_page=EXCLUDED.physical_page,
            chunk_id=EXCLUDED.chunk_id,stem_snapshot=EXCLUDED.stem_snapshot,artifact_kind=EXCLUDED.artifact_kind,session_id=EXCLUDED.session_id,updated_at=now()
          WHERE opening_problem_refs.workspace_id=${scope.workspaceId}
            AND (opening_problem_refs.source_id,opening_problem_refs.source_version,opening_problem_refs.physical_page,opening_problem_refs.chunk_id,
              opening_problem_refs.stem_snapshot,opening_problem_refs.artifact_kind,opening_problem_refs.session_id)
              IS DISTINCT FROM (EXCLUDED.source_id,EXCLUDED.source_version,EXCLUDED.physical_page,EXCLUDED.chunk_id,EXCLUDED.stem_snapshot,EXCLUDED.artifact_kind,EXCLUDED.session_id)
          RETURNING problem_id`;
        if (changed.length) {
          await nextWorkspaceLearningHistoryRevision(tx, scope);
          const roots = await tx`SELECT DISTINCT COALESCE(o.root_observation_id,o.id) AS root_id FROM opening_learning_observations o
            JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
            WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND v.problem_id=${ref.problemId}`;
          await invalidateOpeningLearningEligibility(tx, scope, { rootIds: roots.map(row => String(row.root_id)) });
        }
      });
    },
    async insertHelpExposure(scope: Scope, exposure: Omit<HelpExposure, "createdAt"> & { createdAt?: string }): Promise<HelpExposure> {
      return sql.begin(async (tx) => { await lockWorkspaceLearningHistory(tx, scope); return insertOpeningDeliveredHelp(tx, scope, exposure); });
    },
    async listDeliveredExposures(scope: Scope, sessionId: string): Promise<Array<"hinted" | "revealed">> {
      if (!await getSession(scope, sessionId)) throw learningError("NOT_FOUND", "session not found");
      const rows = await sql`SELECT level FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND session_id=${sessionId} AND delivered=TRUE`;
      return rows.map((r) => r.level as "hinted" | "revealed");
    },
    async listObservationsForCourse(scope: Scope, courseId: string): Promise<LearningObservation[]> {
      const rows = await sql`SELECT o.* FROM opening_learning_observations o JOIN workspaces w ON w.id=o.workspace_id
        WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND w.owner_user_id=${scope.ownerUserId}
          AND o.course_id=${courseId} ORDER BY o.occurred_at,o.id`;
      return rows.map(mapLearningObservation);
    },
    insertObservation(scope: Scope, input: ObservationInput, opts?: Parameters<typeof insertOpeningLearningObservation>[3]) {
      return insertOpeningLearningObservation(sql, scope, input, opts);
    },
  };
}
export type OpeningLearningRepository = ReturnType<typeof createOpeningLearningRepository>;
