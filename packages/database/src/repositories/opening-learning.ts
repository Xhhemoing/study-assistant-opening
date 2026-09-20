import { randomUUID } from "node:crypto";
import type {
  HelpExposure,
  LearningObservation,
  LearningSessionCreateInput,
  ObservationInput,
  ProblemRef,
  Scope,
} from "@aistudy/contracts";
import {
  qualifyObservationAssistance,
  type HelpExposureLevel,
} from "@aistudy/domain";

/**
 * Opening learning repository (L01).
 * Wire `db` to the same SQL/drizzle client used by createOpeningSourceRepository.
 */
export type OpeningLearningDb = {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  execute: (sql: string, params?: unknown[]) => Promise<void>;
};

type SessionRow = {
  id: string;
  courseId: string;
  skillLabel: string;
  sourceIds: string[];
};

export function createOpeningLearningRepository(db: OpeningLearningDb) {
  async function getSession(
    scope: Scope,
    sessionId: string,
  ): Promise<SessionRow | null> {
    const rows = await db.query<{
      id: string;
      course_id: string;
      skill_label: string;
      source_ids: string[];
    }>(
      `SELECT id, course_id, skill_label, source_ids
       FROM opening_learning_sessions
       WHERE id = $1 AND workspace_id = $2 AND owner_user_id = $3`,
      [sessionId, scope.workspaceId, scope.ownerUserId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      courseId: row.course_id,
      skillLabel: row.skill_label,
      sourceIds: row.source_ids,
    };
  }

  async function listDeliveredExposures(
    scope: Scope,
    sessionId: string,
  ): Promise<HelpExposureLevel[]> {
    const owned = await getSession(scope, sessionId);
    if (!owned) {
      throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
    }
    const rows = await db.query<{ level: HelpExposureLevel }>(
      `SELECT level FROM opening_help_exposures
       WHERE workspace_id = $1 AND session_id = $2 AND delivered = TRUE`,
      [scope.workspaceId, sessionId],
    );
    return rows.map((r) => r.level);
  }

  return {
    createSession: async (
      scope: Scope,
      input: LearningSessionCreateInput,
    ): Promise<{ id: string }> => {
      const id = randomUUID();
      await db.execute(
        `INSERT INTO opening_learning_sessions
          (id, workspace_id, owner_user_id, course_id, skill_label, source_ids)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          scope.workspaceId,
          scope.ownerUserId,
          input.courseId,
          input.skillLabel,
          input.sourceIds,
        ],
      );
      return { id };
    },

    getSession,

    insertHelpExposure: async (
      scope: Scope,
      exposure: Omit<HelpExposure, "createdAt"> & { createdAt?: string },
    ): Promise<HelpExposure> => {
      if (exposure.delivered !== true) {
        throw Object.assign(new Error("help exposure must be delivered"), {
          code: "VALIDATION",
        });
      }
      const owned = await getSession(scope, exposure.sessionId);
      if (!owned) {
        throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
      }
      const createdAt = exposure.createdAt ?? new Date().toISOString();
      await db.execute(
        `INSERT INTO opening_help_exposures
          (id, workspace_id, session_id, problem_id, turn_id, level, delivered, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)`,
        [
          exposure.id,
          scope.workspaceId,
          exposure.sessionId,
          exposure.problemId,
          exposure.turnId,
          exposure.level,
          createdAt,
        ],
      );
      return { ...exposure, delivered: true, createdAt };
    },

    listDeliveredExposures,

    upsertProblemRef: async (
      scope: Scope,
      ref: ProblemRef & { sessionId: string },
    ): Promise<void> => {
      const owned = await getSession(scope, ref.sessionId);
      if (!owned) {
        throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
      }
      await db.execute(
        `INSERT INTO opening_problem_refs
          (problem_id, workspace_id, session_id, source_id, source_version,
           physical_page, chunk_id, stem_snapshot, artifact_kind, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (problem_id) DO UPDATE SET
           source_id = EXCLUDED.source_id,
           source_version = EXCLUDED.source_version,
           physical_page = EXCLUDED.physical_page,
           chunk_id = EXCLUDED.chunk_id,
           stem_snapshot = EXCLUDED.stem_snapshot,
           artifact_kind = EXCLUDED.artifact_kind,
           session_id = EXCLUDED.session_id,
           updated_at = now()
         WHERE opening_problem_refs.workspace_id = $2`,
        [
          ref.problemId,
          scope.workspaceId,
          ref.sessionId,
          ref.sourceId,
          ref.sourceVersion,
          ref.physicalPage,
          ref.chunkId,
          ref.stemSnapshot,
          ref.artifactKind,
        ],
      );
    },

    listObservationsForCourse: async (
      scope: Scope,
      courseId: string,
    ): Promise<LearningObservation[]> => {
      const rows = await db.query<{
        id: string;
        workspace_id: string;
        session_id: string;
        course_id: string;
        skill_label: string;
        source_ids: string[];
        problem_id: string | null;
        retest_id: string | null;
        answer: string;
        outcome: LearningObservation["outcome"];
        assistance: LearningObservation["assistance"];
        client_key: string;
        occurred_at: string;
        source_turn_ids: string[];
        verdict_source: LearningObservation["verdictSource"];
        reference_source_id: string | null;
        evidence_verdict: LearningObservation["evidenceVerdict"];
      }>(
        `SELECT id, workspace_id, session_id, course_id, skill_label, source_ids,
                problem_id, retest_id, answer, outcome, assistance, client_key,
                occurred_at, source_turn_ids, verdict_source, reference_source_id, evidence_verdict
         FROM opening_learning_observations
         WHERE workspace_id = $1 AND owner_user_id = $2 AND course_id = $3
         ORDER BY occurred_at ASC`,
        [scope.workspaceId, scope.ownerUserId, courseId],
      );
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        courseId: row.course_id,
        skillLabel: row.skill_label,
        sourceIds: row.source_ids ?? [],
        problemId: row.problem_id,
        retestId: row.retest_id,
        answer: row.answer,
        outcome: row.outcome,
        assistance: row.assistance,
        clientKey: row.client_key,
        occurredAt: new Date(row.occurred_at).toISOString(),
        sourceTurnIds: row.source_turn_ids ?? [],
        verdictSource: row.verdict_source,
        referenceSourceId: row.reference_source_id,
        evidenceVerdict: row.evidence_verdict,
      }));
    },

        insertObservation: async (
      scope: Scope,
      input: ObservationInput,
      opts?: {
        verdictSource?: LearningObservation["verdictSource"];
        referenceSourceId?: string | null;
        sourceTurnIds?: string[];
      },
    ): Promise<LearningObservation & { allowsIndependent: boolean }> => {
      const session = await getSession(scope, input.sessionId);
      if (!session) {
        throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
      }

      const exposures = await listDeliveredExposures(scope, input.sessionId);
      const { assistance, allowsIndependent } = qualifyObservationAssistance({
        declared: input.assistance,
        exposures,
        problemId: input.problemId,
        outcome: input.outcome,
      });

      const id = randomUUID();
      const occurredAt = new Date().toISOString();
      const verdictSource = opts?.verdictSource ?? "self_report";
      const referenceSourceId = opts?.referenceSourceId ?? null;
      const sourceTurnIds = opts?.sourceTurnIds ?? [];
      const evidenceVerdict = "MASTERY_NOT_ESTABLISHED" as const;

      try {
        await db.execute(
          `INSERT INTO opening_learning_observations
            (id, workspace_id, owner_user_id, session_id, course_id, skill_label, source_ids,
             problem_id, retest_id, answer, outcome, assistance, client_key, occurred_at,
             source_turn_ids, verdict_source, reference_source_id, evidence_verdict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            id,
            scope.workspaceId,
            scope.ownerUserId,
            input.sessionId,
            input.courseId,
            input.skillLabel,
            input.sourceIds,
            input.problemId ?? null,
            input.retestId ?? null,
            input.answer,
            input.outcome,
            assistance,
            input.clientKey,
            occurredAt,
            sourceTurnIds,
            verdictSource,
            referenceSourceId,
            evidenceVerdict,
          ],
        );
      } catch (err) {
        // Unique (workspace_id, client_key) => idempotent replay of prior observation.
        const existing = await db.query<{
          id: string;
          assistance: LearningObservation["assistance"];
          occurred_at: string;
          source_turn_ids: string[];
          verdict_source: LearningObservation["verdictSource"];
          reference_source_id: string | null;
          evidence_verdict: LearningObservation["evidenceVerdict"];
          answer: string;
          outcome: LearningObservation["outcome"];
          course_id: string;
          skill_label: string;
          source_ids: string[];
          problem_id: string | null;
          retest_id: string | null;
          session_id: string;
          client_key: string;
        }>(
          `SELECT id, assistance, occurred_at, source_turn_ids, verdict_source, reference_source_id,
                  evidence_verdict, answer, outcome, course_id, skill_label, source_ids,
                  problem_id, retest_id, session_id, client_key
           FROM opening_learning_observations
           WHERE workspace_id = $1 AND client_key = $2 AND owner_user_id = $3
           LIMIT 1`,
          [scope.workspaceId, input.clientKey, scope.ownerUserId],
        );
        const row = existing[0];
        if (!row) {
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
            code: "CONFLICT",
          });
        }
        const replayAllows = qualifyObservationAssistance({
          declared: row.assistance,
          exposures: [],
          problemId: row.problem_id,
          outcome: row.outcome,
        }).allowsIndependent;
        return {
          sessionId: row.session_id,
          courseId: row.course_id,
          skillLabel: row.skill_label,
          sourceIds: row.source_ids,
          problemId: row.problem_id,
          retestId: row.retest_id,
          answer: row.answer,
          outcome: row.outcome,
          assistance: row.assistance,
          clientKey: row.client_key,
          id: row.id,
          workspaceId: scope.workspaceId,
          occurredAt: new Date(row.occurred_at).toISOString(),
          sourceTurnIds: row.source_turn_ids ?? [],
          verdictSource: row.verdict_source,
          referenceSourceId: row.reference_source_id,
          evidenceVerdict: row.evidence_verdict,
          allowsIndependent: replayAllows,
        };
      }

      return {
        ...input,
        assistance,
        id,
        workspaceId: scope.workspaceId,
        occurredAt,
        sourceTurnIds,
        verdictSource,
        referenceSourceId,
        evidenceVerdict,
        allowsIndependent,
      };
    },
  };
}

export type OpeningLearningRepository = ReturnType<
  typeof createOpeningLearningRepository
>;
