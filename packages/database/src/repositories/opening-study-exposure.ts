import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import type { Scope, StudyContextAnchor, StudyExposureReceipt } from "@aistudy/contracts";
import { learningError, learningIso, lockWorkspaceLearningHistory, nextLearningHistoryRevision, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";
import { resolveOpeningStudyContext } from "./opening-study-context";

export type OpeningStudyExposureInput = {
  releaseKey: string;
  contextAnchor: StudyContextAnchor;
  origin: StudyExposureReceipt["origin"];
  originReference?: { type: "source" | "note" | "card" | "observation"; id: string; version: string; sourceRefs?: Array<{ sourceId: string; sourceVersion: number | null }>; requirementKey?: string | null; skillLabel?: string | null; possibleOpenAttemptOnly?: boolean };
  /** Server delivery policy only. Never copy an HTTP field into this value. */
  supportDomain?: StudyExposureReceipt["supportDomain"];
  kind: "instruction" | "hint" | "solution";
  level: "hinted" | "revealed";
  sessionId?: string | null;
  turnId?: string | null;
};
type Row = Record<string, unknown>;
export function mapOpeningStudyExposure(row: Row): StudyExposureReceipt {
  return { id: String(row.id), releaseKey: String(row.release_key), contextAnchor: row.context_anchor as StudyContextAnchor,
    origin: row.exposure_origin as StudyExposureReceipt["origin"], supportDomain: row.support_domain as StudyExposureReceipt["supportDomain"],
    generatedAt: learningIso(row.generated_at)!, releasedAt: learningIso(row.released_at), acknowledgedAt: learningIso(row.acknowledged_at),
    historyRevision: Number(row.history_revision) };
}

/** Caller holds the workspace history lock. Publishing and answer submission share this order. */
export async function generateOpeningStudyExposure(tx: TransactionSql, scope: Scope, input: OpeningStudyExposureInput): Promise<StudyExposureReceipt> {
  const storedIntent = JSON.parse(JSON.stringify(input)) as OpeningStudyExposureInput;
  const [existing] = await tx`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND release_key=${input.releaseKey} FOR UPDATE`;
  // Replays use the persisted identities. A new material version must not rewrite an old receipt.
  if (existing) {
    if (existing.owner_user_id !== scope.ownerUserId || !isDeepStrictEqual(existing.release_intent, storedIntent)) {
      throw learningError("CONFLICT", "release receipt intent changed");
    }
    return mapOpeningStudyExposure(existing);
  }
  const anchor = await resolveOpeningStudyContext(tx, scope, input.contextAnchor, { sessionId: input.sessionId, sourceAccess: input.origin === "assistant" ? "ai" : "human_read", associationOnly: input.origin !== "assistant" && input.originReference?.possibleOpenAttemptOnly === true });
  let problemId: string | null = null;
  if (anchor.attemptId) {
    const [attempt] = await tx`SELECT problem_id FROM opening_learning_attempts WHERE id=${anchor.attemptId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    problemId = attempt?.problem_id as string | null;
  } else if (anchor.itemVersionId) {
    const [item] = await tx`SELECT problem_id FROM opening_learning_item_versions WHERE id=${anchor.itemVersionId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    problemId = item?.problem_id as string | null;
  }
  const [row] = await tx`INSERT INTO opening_help_exposures(id,workspace_id,owner_user_id,course_id,session_id,attempt_id,problem_id,
    item_version_id,activity_id,turn_id,kind,level,delivered,release_key,release_intent,context_anchor,exposure_origin,support_domain,generated_at,history_revision)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${anchor.courseId ?? null},${input.sessionId ?? null},${anchor.attemptId ?? null},${problemId},
      ${anchor.itemVersionId ?? null},${anchor.activityId ?? null},${input.turnId ?? null},${input.kind},${input.level},FALSE,${input.releaseKey},
      ${tx.json(storedIntent)},${tx.json(anchor)},${input.origin},${input.supportDomain ?? "unknown"},clock_timestamp(),0) RETURNING *`;
  return mapOpeningStudyExposure(row!);
}

export async function releaseOpeningStudyExposure(tx: TransactionSql, scope: Scope, receiptId: string): Promise<StudyExposureReceipt> {
  const [row] = await tx`SELECT * FROM opening_help_exposures WHERE id=${receiptId} AND workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND release_key IS NOT NULL FOR UPDATE`;
  if (!row) throw learningError("NOT_FOUND", "release receipt not found");
  if (row.released_at != null) return mapOpeningStudyExposure(row);
  // Recheck availability immediately before release, never silently rebind to a newer version.
  await resolveOpeningStudyContext(tx, scope, row.context_anchor as StudyContextAnchor, { sessionId: row.session_id as string | null, sourceAccess: row.exposure_origin === "assistant" ? "ai" : "human_read",
    associationOnly: row.exposure_origin !== "assistant" && (row.release_intent as OpeningStudyExposureInput | null)?.originReference?.possibleOpenAttemptOnly === true });
  const revision = row.course_id == null ? 0 : await nextLearningHistoryRevision(tx, scope, String(row.course_id));
  const workspaceRevision = await nextWorkspaceLearningHistoryRevision(tx, scope);
  const [released] = await tx`UPDATE opening_help_exposures SET delivered=TRUE,released_at=clock_timestamp(),delivered_at=clock_timestamp(),
    history_revision=${revision},workspace_history_revision=${workspaceRevision} WHERE id=${receiptId} RETURNING *`;
  // Include currently projected answers and same-source unknown associations. Uncertainty cannot grant independence.
  const roots = await tx`SELECT DISTINCT COALESCE(o.root_observation_id,o.id) AS root_id FROM opening_learning_observations o
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND (${row.course_id == null} OR o.course_id IS NOT DISTINCT FROM ${row.course_id}::uuid)
      AND (o.attempt_id=${row.attempt_id} OR o.problem_id=${row.problem_id}
        OR (${row.attempt_id == null && row.problem_id == null} AND
          (o.session_id=${row.session_id}
            OR (${(row.context_anchor as StudyContextAnchor | null)?.sourceId != null} AND
              o.source_ids @> ${[(row.context_anchor as StudyContextAnchor | null)?.sourceId].filter((id): id is string => Boolean(id))}::uuid[])
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(${row.release_intent ? tx.json(row.release_intent) : null}::jsonb->'originReference'->'sourceRefs','[]'::jsonb)) ref
              WHERE ref->>'sourceId'=ANY(o.source_ids::text[]) AND ${row.release_intent ? tx.json(row.release_intent) : null}::jsonb->'originReference'->>'skillLabel'=o.skill_label))))`;
  await invalidateOpeningLearningEligibility(tx, scope, { rootIds: roots.map(root => String(root.root_id)) });
  return mapOpeningStudyExposure(released!);
}

/** Called by delivery boundaries; query readers themselves remain read-only. */
export function createOpeningStudyExposureRepository(sql: Sql) {
  return {
    generate: (scope: Scope, input: OpeningStudyExposureInput) => sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope); return generateOpeningStudyExposure(tx, scope, input);
    }) as Promise<StudyExposureReceipt>,
    release: (scope: Scope, receiptId: string) => sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope); return releaseOpeningStudyExposure(tx, scope, receiptId);
    }) as Promise<StudyExposureReceipt>,
    /** One transaction ensures nothing is returned before its conservative release is committed. */
    deliver: (scope: Scope, input: OpeningStudyExposureInput) => sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const generated = await generateOpeningStudyExposure(tx, scope, input);
      return releaseOpeningStudyExposure(tx, scope, generated.id);
    }) as Promise<StudyExposureReceipt>,
    async acknowledge(scope: Scope, receiptId: string): Promise<StudyExposureReceipt> {
      const [row] = await sql`UPDATE opening_help_exposures SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp())
        WHERE id=${receiptId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND released_at IS NOT NULL RETURNING *`;
      if (!row) throw learningError("NOT_FOUND", "released receipt not found");
      return mapOpeningStudyExposure(row);
    },
  };
}
