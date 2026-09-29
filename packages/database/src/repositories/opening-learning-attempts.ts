import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import type { LearningAttempt, LearningAttemptCreateInput, Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, learningIso, lockLearningHistory, lockLearningOwner, lockLearningSession, nextLearningHistoryRevision } from "./opening-learning-facts";

export function mapLearningAttempt(row: Record<string, unknown>): LearningAttempt {
  return { id: String(row.id), workspaceId: String(row.workspace_id), sessionId: String(row.session_id), courseId: String(row.course_id),
    skillLabel: String(row.skill_label), requirementKey: row.requirement_key as string | null, problemId: row.problem_id as string | null,
    itemVersionId: row.item_version_id as string | null, sourceIds: row.source_ids as string[], sourceVersions: row.source_versions as Record<string, number>,
    startedAt: learningIso(row.started_at)!, submittedAt: learningIso(row.submitted_at), observationId: row.observation_id as string | null,
    historyRevision: Number(row.history_revision) };
}
export function createOpeningLearningAttemptRepository(sql: Sql) {
  return {
    async get(scope: Scope, id: string): Promise<LearningAttempt | null> {
      const rows = await sql`SELECT a.* FROM opening_learning_attempts a JOIN workspaces w ON w.id=a.workspace_id
        WHERE a.id=${id} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND w.owner_user_id=${scope.ownerUserId}`;
      return rows[0] ? mapLearningAttempt(rows[0]) : null;
    },
    async create(scope: Scope, input: LearningAttemptCreateInput): Promise<LearningAttempt> {
      return sql.begin(async (tx) => {
        const session = await lockLearningSession(tx, scope, input.sessionId);
        const courseId = String(session.course_id);
        await lockLearningHistory(tx, scope, courseId);
        const sources = await admitLearningSources(tx, scope, session.source_ids as string[]);
        const sourceVersions = Object.fromEntries(sources.map((s) => [String(s.id), Number(s.version)]));
        const intent = { sessionId: input.sessionId, problemId: input.problemId ?? null, problem: input.problem ?? null, requirementKey: input.requirementKey ?? null };
        const replay = await tx`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
        if (replay[0]) {
          if (!isDeepStrictEqual(replay[0].create_intent, intent)) throw learningError("CONFLICT", "attempt clientKey payload conflict");
          return mapLearningAttempt(replay[0]);
        }
        let problemId = input.problemId ?? null, itemVersionId: string | null = null;
        if (input.problem) {
          const problem = input.problem;
          if (!(session.source_ids as string[]).includes(problem.sourceId)) throw learningError("VALIDATION", "problem source is outside session");
          if (problem.chunkId) {
            const chunks = await tx`SELECT id FROM opening_source_chunks WHERE id=${problem.chunkId} AND source_id=${problem.sourceId}
              AND source_version=${sourceVersions[problem.sourceId]!} AND (${problem.physicalPage ?? null}::int IS NULL OR page=${problem.physicalPage ?? null})`;
            if (!chunks.length) throw learningError("VALIDATION", "problem chunk does not match captured source");
          }
          problemId = randomUUID();
          await tx`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,physical_page,chunk_id,stem_snapshot,artifact_kind)
            VALUES (${problemId},${scope.workspaceId},${input.sessionId},${problem.sourceId},${sourceVersions[problem.sourceId]!},${problem.physicalPage ?? null},${problem.chunkId ?? null},${problem.stemSnapshot},${problem.artifactKind})`;
        }
        if (problemId) {
          const refs = await tx`SELECT p.* FROM opening_problem_refs p JOIN opening_learning_sessions l ON l.id=p.session_id
            WHERE p.problem_id=${problemId} AND p.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.course_id=${courseId} FOR SHARE OF p`;
          const ref = refs[0];
          if (!ref || !(session.source_ids as string[]).includes(String(ref.source_id))) throw learningError("VALIDATION", "problem is outside the session course or sources");
          sourceVersions[String(ref.source_id)] = Number(ref.source_version);
          const versions = await tx`SELECT id FROM opening_learning_item_versions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND problem_id=${problemId} AND source_id=${ref.source_id} AND source_version=${ref.source_version}
            AND stem_snapshot=${ref.stem_snapshot} AND artifact_kind=${ref.artifact_kind}
            AND chunk_id IS NOT DISTINCT FROM ${ref.chunk_id} AND physical_page IS NOT DISTINCT FROM ${ref.physical_page} ORDER BY created_at LIMIT 1`;
          itemVersionId = versions[0] ? String(versions[0].id) : randomUUID();
          if (!versions.length) await tx`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,problem_id,source_id,source_version,physical_page,chunk_id,stem_snapshot,artifact_kind)
            VALUES (${itemVersionId},${scope.workspaceId},${scope.ownerUserId},${courseId},${problemId},${ref.source_id},${ref.source_version},${ref.physical_page},${ref.chunk_id},${ref.stem_snapshot},${ref.artifact_kind})`;
        }
        const revision = await nextLearningHistoryRevision(tx, scope, courseId);
        const rows = await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,skill_label,requirement_key,problem_id,item_version_id,source_ids,source_versions,client_key,create_intent,history_revision)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.sessionId},${courseId},${session.skill_label},${input.requirementKey ?? null},${problemId},${itemVersionId},${session.source_ids},${tx.json(sourceVersions)},${input.clientKey},${tx.json(intent as never)},${revision})
          ON CONFLICT (workspace_id,owner_user_id,client_key) DO NOTHING RETURNING *`;
        if (!rows[0]) throw learningError("CONFLICT", "attempt clientKey already used");
        return mapLearningAttempt(rows[0]);
      });
    },
    async assertAccess(scope: Scope, id: string) {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const rows = await tx`SELECT * FROM opening_learning_attempts WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!rows[0]) throw learningError("NOT_FOUND", "attempt not found");
        await admitLearningSources(tx, scope, rows[0].source_ids as string[]);
        return mapLearningAttempt(rows[0]);
      });
    },
  };
}
