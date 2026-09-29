import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { HelpExposure, LearningObservation, LearningSessionCreateInput, ObservationInput, ObservationRevisionInput, ProblemRef, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, lockLearningOwner, lockLearningSession, mapLearningObservation } from "./opening-learning-facts";
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
        const id = randomUUID();
        await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,skill_label,source_ids)
          VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${input.skillLabel},${input.sourceIds})`;
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
        const session = await lockLearningSession(tx, scope, ref.sessionId);
        if (!(session.source_ids as string[]).includes(ref.sourceId)) throw learningError("VALIDATION", "problem source is outside session");
        await admitLearningSources(tx, scope, [ref.sourceId]);
        await tx`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,physical_page,chunk_id,stem_snapshot,artifact_kind)
          VALUES (${ref.problemId},${scope.workspaceId},${ref.sessionId},${ref.sourceId},${ref.sourceVersion},${ref.physicalPage},${ref.chunkId},${ref.stemSnapshot},${ref.artifactKind})
          ON CONFLICT(problem_id) DO UPDATE SET source_id=EXCLUDED.source_id,source_version=EXCLUDED.source_version,physical_page=EXCLUDED.physical_page,
            chunk_id=EXCLUDED.chunk_id,stem_snapshot=EXCLUDED.stem_snapshot,artifact_kind=EXCLUDED.artifact_kind,session_id=EXCLUDED.session_id,updated_at=now()
          WHERE opening_problem_refs.workspace_id=${scope.workspaceId}`;
      });
    },
    async insertHelpExposure(scope: Scope, exposure: Omit<HelpExposure, "createdAt"> & { createdAt?: string }): Promise<HelpExposure> {
      return sql.begin((tx) => insertOpeningDeliveredHelp(tx, scope, exposure));
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
