import { randomUUID } from "node:crypto";
import {
  knowledgeSnapshotSchema,
  skillEvidenceSchema,
  type Scope,
  type SkillEvidence,
} from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "@aistudy/domain";
import { learningError, mapLearningObservation, type LearningSql } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { openingCurrentKnowledgeNodesQuery } from "./opening-exam-skill-identity";

export type SkillEvidenceDimension = SkillEvidence["dimension"];

export type LinkSkillEvidenceInput = {
  nodeId: string;
  observationId: string;
  dimension: SkillEvidenceDimension;
  /** Defaults to the observation's course when omitted. */
  courseId?: string;
};

export type SkillEvidenceRecord = SkillEvidence & {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  courseId: string;
  createdAt: string;
};

/** Server-derived flags for adaptive tutor recommend (never client-self-reported). */
export type NodeSkillEvidenceFlags = {
  nodeId: string;
  hasCheckedIndependent: boolean;
  hasAssistance: boolean;
  evidenceIds: string[];
};

function mapRow(row: Record<string, unknown>): SkillEvidenceRecord {
  const base = skillEvidenceSchema.parse({
    nodeId: String(row.node_id),
    observationId: String(row.observation_id),
    dimension: row.dimension,
  });
  return {
    ...base,
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerUserId: String(row.owner_user_id),
    courseId: String(row.course_id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

async function assertOwnedWorkspace(db: LearningSql, scope: Scope): Promise<void> {
  const rows = await db`
    SELECT id FROM workspaces
    WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
  if (!rows.length) throw learningError("NOT_FOUND", "workspace not found");
}

async function loadOwnedObservation(
  db: LearningSql,
  scope: Scope,
  observationId: string,
): Promise<{ id: string; courseId: string; assistance: string }> {
  const rows = await db`
    SELECT o.id, o.course_id, o.assistance
    FROM opening_learning_observations o
    JOIN workspaces w ON w.id = o.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
    WHERE o.id = ${observationId}
      AND o.workspace_id = ${scope.workspaceId}
      AND o.owner_user_id = ${scope.ownerUserId}`;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw learningError("NOT_FOUND", "observation not found");
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    assistance: String(row.assistance),
  };
}

/**
 * When a course knowledge snapshot exists, nodeId must appear in it.
 * No snapshot → allow link (logical node ref; K01 may land later).
 */
async function assertNodeInCourseSnapshot(
  db: LearningSql,
  scope: Scope,
  courseId: string,
  nodeId: string,
): Promise<void> {
  const rows = await db`
    SELECT snapshot FROM opening_course_knowledge
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND course_id = ${courseId}`;
  if (!rows.length) return;
  const snapshot = knowledgeSnapshotSchema.parse((rows[0] as Record<string, unknown>).snapshot);
  if (!snapshot.nodes.some((node) => node.id === nodeId)) {
    throw learningError("VALIDATION", "nodeId is not in the course knowledge snapshot");
  }
}

async function insertLink(
  db: LearningSql,
  scope: Scope,
  input: {
    courseId: string;
    nodeId: string;
    observationId: string;
    dimension: SkillEvidenceDimension;
  },
): Promise<SkillEvidenceRecord> {
  const id = randomUUID();
  const rows = await db`
    INSERT INTO opening_skill_evidence (
      id, workspace_id, owner_user_id, course_id, node_id, observation_id, dimension
    ) VALUES (
      ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.courseId},
      ${input.nodeId}, ${input.observationId}, ${input.dimension}
    )
    ON CONFLICT (workspace_id, observation_id, node_id, dimension) DO UPDATE SET
      node_id = EXCLUDED.node_id
    RETURNING *`;
  return mapRow(rows[0] as Record<string, unknown>);
}

/**
 * Link SkillEvidence inside an existing learning write transaction.
 * Caller already owns observation insert; this only adds the projection row.
 */
export async function linkOpeningSkillEvidenceInTx(
  tx: TransactionSql,
  scope: Scope,
  input: LinkSkillEvidenceInput & { courseId: string },
): Promise<SkillEvidenceRecord> {
  await assertOwnedWorkspace(tx, scope);
  skillEvidenceSchema.parse({
    nodeId: input.nodeId,
    observationId: input.observationId,
    dimension: input.dimension,
  });
  await assertNodeInCourseSnapshot(tx, scope, input.courseId, input.nodeId);
  return insertLink(tx, scope, {
    courseId: input.courseId,
    nodeId: input.nodeId,
    observationId: input.observationId,
    dimension: input.dimension,
  });
}

/**
 * SkillEvidence stays a course-scoped projection from eligible observations.
 * V2-13: there is intentionally no activity-complete → link API; completing a
 * teaching activity must not call link / linkOpeningSkillEvidenceInTx.
 */
export function createOpeningSkillEvidenceRepository(sql: Sql) {
  return {
    /**
     * Idempotent SkillEvidence link. Validates observation ownership and,
     * when a knowledge snapshot exists, that nodeId belongs to that course.
     * Not callable from activity status=completed transitions (V2-13).
     */
    async link(scope: Scope, input: LinkSkillEvidenceInput): Promise<SkillEvidenceRecord> {
      skillEvidenceSchema.parse({
        nodeId: input.nodeId,
        observationId: input.observationId,
        dimension: input.dimension,
      });
      return sql.begin(async (tx) => {
        await assertOwnedWorkspace(tx, scope);
        const observation = await loadOwnedObservation(tx, scope, input.observationId);
        const courseId = input.courseId ?? observation.courseId;
        if (input.courseId && input.courseId !== observation.courseId) {
          throw learningError("VALIDATION", "courseId does not match the observation");
        }
        const course = await tx`
          SELECT c.id FROM courses c
          JOIN workspaces w ON w.id = c.workspace_id
          WHERE c.id = ${courseId}
            AND c.workspace_id = ${scope.workspaceId}
            AND w.owner_user_id = ${scope.ownerUserId}
            AND c.archived_at IS NULL`;
        if (!course.length) throw learningError("NOT_FOUND", "course not found");
        await assertNodeInCourseSnapshot(tx, scope, courseId, input.nodeId);
        return insertLink(tx, scope, {
          courseId,
          nodeId: input.nodeId,
          observationId: input.observationId,
          dimension: input.dimension,
        });
      });
    },

    async listByNode(scope: Scope, nodeId: string): Promise<SkillEvidenceRecord[]> {
      await assertOwnedWorkspace(sql, scope);
      const rows = await sql`
        SELECT e.* FROM opening_skill_evidence e
        WHERE e.workspace_id = ${scope.workspaceId}
          AND e.owner_user_id = ${scope.ownerUserId}
          AND e.node_id = ${nodeId}
        ORDER BY e.created_at, e.id`;
      return rows.map((row) => mapRow(row as Record<string, unknown>));
    },

    async listByObservation(
      scope: Scope,
      observationId: string,
    ): Promise<SkillEvidenceRecord[]> {
      await assertOwnedWorkspace(sql, scope);
      const rows = await sql`
        SELECT e.* FROM opening_skill_evidence e
        WHERE e.workspace_id = ${scope.workspaceId}
          AND e.owner_user_id = ${scope.ownerUserId}
          AND e.observation_id = ${observationId}
        ORDER BY e.created_at, e.id`;
      return rows.map((row) => mapRow(row as Record<string, unknown>));
    },

    /**
     * Flags Experience/AI need for recommendAdaptiveTutorAction.
     * Independent = linked observation passes eligibility (independent + verified + usable).
     * Only current supported nodes and usable effective heads contribute flags.
     * Historical links stay available through listByNode/listByObservation.
     */
    async flagsForNode(scope: Scope, nodeId: string): Promise<NodeSkillEvidenceFlags> {
      return sql.begin("isolation level repeatable read", async tx => {
        await assertOwnedWorkspace(tx, scope);
        const rows = await tx`
        SELECT o.*,e.id AS evidence_id
        FROM opening_skill_evidence e
        JOIN courses c ON c.id=e.course_id AND c.workspace_id=e.workspace_id AND c.archived_at IS NULL
        JOIN (${openingCurrentKnowledgeNodesQuery(tx, scope)}) node ON node.course_id=e.course_id AND node.node_id=e.node_id
        JOIN opening_learning_observations linked ON linked.id=e.observation_id
          AND linked.workspace_id=e.workspace_id AND linked.owner_user_id=e.owner_user_id
        JOIN opening_learning_observations root ON root.id=COALESCE(linked.root_observation_id,linked.id)
          AND root.workspace_id=e.workspace_id AND root.owner_user_id=e.owner_user_id
        JOIN opening_learning_observations o ON o.id=COALESCE(root.effective_head_id,root.id)
          AND o.workspace_id=e.workspace_id AND o.owner_user_id=e.owner_user_id AND o.course_id=e.course_id
        WHERE e.workspace_id = ${scope.workspaceId}
          AND e.owner_user_id = ${scope.ownerUserId}
          AND e.node_id = ${nodeId}
          AND COALESCE(o.revision_kind,'original')<>'retract'
        ORDER BY e.created_at, e.id`;
        const heads = [...new Map(rows.map(row => [String(row.id), mapLearningObservation(row)])).values()];
        const contexts = await readOpeningLearningEvidenceContexts(tx, scope, heads);
        let hasCheckedIndependent = false, hasAssistance = false;
        const evidenceIds: string[] = [];
        for (const row of rows) {
          const facts = contexts[String(row.id)]!;
          const eligibility = evaluateEvidenceEligibility(facts.observation, facts.context);
          if (eligibility.usableForCurrentVersion !== "yes") continue;
          evidenceIds.push(String(row.evidence_id));
          const assistance = resolveEvidenceAssistance(facts.observation, facts.context);
          if (assistance === "hinted" || assistance === "revealed") hasAssistance = true;
          if (eligibility.independentAttempt === "yes" && eligibility.verifiedCorrect === "yes") hasCheckedIndependent = true;
        }
        return { nodeId, hasCheckedIndependent, hasAssistance, evidenceIds };
      }) as Promise<NodeSkillEvidenceFlags>;
    },
  };
}

export type OpeningSkillEvidenceRepository = ReturnType<
  typeof createOpeningSkillEvidenceRepository
>;
