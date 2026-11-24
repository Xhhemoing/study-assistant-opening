import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { LEARNER_CONTEXT_MAX_BYTES, type LearnerMisconceptionDisposition, type v3BitemporalMisconceptionEdges } from "../schema/v3-bitemporal-memory";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { isLineageUuid, lineageUuid } from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";

type Edge = typeof v3BitemporalMisconceptionEdges.$inferSelect;
type ContextItem = Pick<Edge, "status" | "learnerDisposition" | "summary">;
type RenderedContextBlock = { renderedMarkdown: string; byteLength: number };
type ContextBlock = RenderedContextBlock & { revision: number };
type ContextRevision = ContextItem & Pick<Edge, "revisionId" | "courseId">;
export type TutorMisconceptionSnapshot = RenderedContextBlock & {
  courseId: string | null;
  effectiveCourseId?: string | null;
  privacyEpoch: number;
  revisionIds: readonly string[];
};
export type TutorMisconceptionLineage = {
  kind: "v3_misconception_lineage";
  courseId: string | null;
  revisionIds: readonly string[];
};

export function readSavedTutorMisconceptionLineage(encoded: unknown): TutorMisconceptionLineage | null {
  if (typeof encoded !== "string") return null;
  try { return parseTutorMisconceptionLineage(JSON.parse(encoded)); } catch { return null; }
}

export function parseTutorMisconceptionLineage(parsed: unknown): TutorMisconceptionLineage | null {
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 3) return null;
  const { kind, courseId, revisionIds } = parsed as Record<string, unknown>;
  if (kind !== "v3_misconception_lineage" || !(courseId === null || isLineageUuid(courseId))
    || !Array.isArray(revisionIds) || !revisionIds.every(isLineageUuid)) return null;
  const ids = revisionIds.map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return null;
  return { kind, courseId: courseId?.toLowerCase() ?? null, revisionIds: ids };
}

/** Inline admission for assistant content returned directly from saved conversations. */
export function turnUsesInactiveMisconception(db: Sql | TransactionSql, alias: "t" = "t") {
  const col = (name: string) => db.unsafe(`${alias}.${name}`);
  const encoded = col("intent_hash");
  const course = () => lineageUuid(db, () => db`payload.value->>'courseId'`);
  const revision = () => lineageUuid(db, () => db`entry.value #>> '{}'`);
  return db`CASE WHEN ${col("role")} = 'assistant' AND ${encoded} IS NOT NULL THEN NOT EXISTS (
    SELECT 1 FROM opening_conversations conversation
    JOIN workspaces w ON w.id = conversation.workspace_id AND w.owner_user_id = conversation.owner_user_id
    CROSS JOIN LATERAL (SELECT CASE WHEN ${encoded} IS JSON OBJECT WITH UNIQUE KEYS
      AND pg_input_is_valid(${encoded}, 'jsonb') THEN ${encoded}::jsonb END AS value,
      clock_timestamp() AS at OFFSET 0) payload
    CROSS JOIN LATERAL (SELECT ${course()} AS course_id) lineage
    WHERE conversation.id = ${col("conversation_id")} AND conversation.workspace_id = ${col("workspace_id")}
      AND payload.value-ARRAY['kind','courseId','revisionIds'] = '{}'::jsonb
      AND payload.value->'kind' = '"v3_misconception_lineage"'::jsonb
      AND (payload.value->'courseId' = 'null'::jsonb OR (
        jsonb_typeof(payload.value->'courseId') = 'string' AND lineage.course_id = conversation.course_id
        AND EXISTS (SELECT 1 FROM courses c WHERE c.id = lineage.course_id AND c.workspace_id = w.id AND c.archived_at IS NULL)
      ))
      AND jsonb_typeof(payload.value->'revisionIds') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload.value->'revisionIds') = 'array'
          THEN payload.value->'revisionIds' ELSE '[]'::jsonb END) entry(value)
        CROSS JOIN LATERAL (SELECT ${revision()} AS id) revision
        LEFT JOIN v3_bitemporal_misconception_edges e ON e.revision_id = revision.id AND e.workspace_id = w.id
          AND e.owner_user_id = w.owner_user_id AND e.privacy_epoch = w.privacy_epoch
          AND (e.course_id IS NULL OR e.course_id = lineage.course_id)
          AND e.valid_range @> payload.at AND e.tx_range @> payload.at
          AND e.status IN ('candidate', 'verified', 'learner_reported')
        GROUP BY revision.id
        HAVING revision.id IS NULL OR count(*) <> 1 OR count(e.revision_id) <> 1
      )
  ) ELSE false END`;
}

/** Check saved authority against the current privacy epoch and both live time ranges. */
export async function readActiveTutorMisconceptionLineages(
  db: Sql | TransactionSql, scope: OpeningScope, lineages: readonly TutorMisconceptionLineage[],
): Promise<Set<number>> {
  if (!lineages.length) return new Set();
  const rows = await db<{ position: number }[]>`
    WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT lineage.position
    FROM workspaces w CROSS JOIN tick
    CROSS JOIN jsonb_to_recordset(${db.json(lineages.map(({ courseId, revisionIds }, position) =>
      ({ position, course_id: courseId, revision_ids: [...revisionIds] })))}::jsonb)
      AS lineage(position integer, course_id uuid, revision_ids uuid[])
    WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId}
      AND (lineage.course_id IS NULL OR EXISTS (
        SELECT 1 FROM courses c WHERE c.id = lineage.course_id AND c.workspace_id = w.id AND c.archived_at IS NULL
      ))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(lineage.revision_ids) AS revision(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM v3_bitemporal_misconception_edges e
          WHERE e.revision_id = revision.id AND e.workspace_id = w.id AND e.owner_user_id = w.owner_user_id
            AND e.privacy_epoch = w.privacy_epoch AND (e.course_id IS NULL OR e.course_id = lineage.course_id)
            AND e.valid_range @> tick.at AND e.tx_range @> tick.at
            AND e.status IN ('candidate', 'verified', 'learner_reported')
        )
      )`;
  return new Set(rows.map(row => row.position));
}

type Revision = { edgeId: string; revisionId: string; txAt: string };
type TryHandoffClock = { readonly nowMs: number; readonly issueSeq: number };
type TryMisconceptionClaim = Pick<Edge, "conceptKey" | "misconceptionCode" | "summary"> & {
  receiptId: string;
  payloadSha256: string;
  issueSeq: number;
  expiresAt: number;
};

/** Use the same clock as redemption and the same sequence as backup restore. */
export async function readTryMisconceptionHandoffClock(sql: Sql | TransactionSql): Promise<TryHandoffClock> {
  const [clock] = await sql<{ nowMs: string; issueSeq: string }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS "nowMs",
      nextval('v3_try_misconception_handoff_seq')::text AS "issueSeq"`;
  const nowMs = Number(clock?.nowMs);
  const issueSeq = Number(clock?.issueSeq);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(issueSeq) || issueSeq <= 0) {
    throw new Error("Invalid PostgreSQL misconception handoff clock");
  }
  return { nowMs, issueSeq };
}
type LearnerCorrection = {
  edgeId: string;
  disposition: LearnerMisconceptionDisposition;
  summary: string;
};

const dispositionLabels: Record<LearnerMisconceptionDisposition, string> = {
  disputed: "学习者提出异议",
  clarified: "学习者补充说明",
  resolved_self_report: "学习者自述已解决",
};

export function renderLearnerContextBlock(items: readonly ContextItem[]) {
  const block = { renderedMarkdown: "", byteLength: 0 };
  appendLearnerContextItems(block, items);
  return block;
}

/** Return false once the renderer has reached the byte limit. */
function appendLearnerContextItems<T extends ContextItem>(
  block: RenderedContextBlock, items: readonly T[], onIncluded?: (item: T) => void,
): boolean {
  for (const item of items) {
    if (item.status === "retracted" || item.status === "superseded") continue;
    const text = item.summary.replace(/[\s\p{Cc}]+/gu, " ").trim()
      .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
    if (!text) continue;
    const label = item.learnerDisposition ? dispositionLabels[item.learnerDisposition]
      : item.status === "verified" ? "已确认" : "待确认";
    const prefix = (block.renderedMarkdown ? "\n- " : "- ") + label + "：";
    const prefixBytes = Buffer.byteLength(prefix);
    const characters: string[] = [];
    let lineBytes = prefixBytes;
    let truncated = false;
    for (const character of text) {
      const literal = "\\`*_{}[]<>()#+-.!|&~".includes(character) ? "\\" + character : character;
      const bytes = Buffer.byteLength(literal);
      if (block.byteLength + lineBytes + bytes > LEARNER_CONTEXT_MAX_BYTES) {
        truncated = true;
        break;
      }
      characters.push(literal);
      lineBytes += bytes;
    }
    if (characters.length) {
      block.renderedMarkdown += prefix + characters.join("");
      block.byteLength += lineBytes;
      onIncluded?.(item);
    }
    if (truncated || block.byteLength === LEARNER_CONTEXT_MAX_BYTES) return false;
  }
  return true;
}

/** Acquire the workspace lock before any course or revision row locks. */
export async function lockMisconceptionWorkspaceForWrite(tx: TransactionSql, scope: OpeningScope): Promise<number> {
  await lockWorkspaceLearningHistory(tx, scope);
  // Serialize writers and context rebuilds while allowing foreign-key key shares.
  const [workspace] = await tx<{ privacy_epoch: number }[]>`
    SELECT privacy_epoch FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR NO KEY UPDATE`;
  if (!workspace) throw learningError("NOT_FOUND", "学习空间不存在。");
  return workspace.privacy_epoch;
}

export async function lockMisconceptionContext(tx: TransactionSql, workspaceId: string) {
  // The migration's revision trigger holds this same lock when invalidating the cache.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('v3:learner-context:' || ${workspaceId}::uuid::text, 0))`;
}

/** Call after the final revision mutation, with the workspace lock still held. */
export async function refreshLearnerMisconceptionContextBlock(
  tx: TransactionSql, scope: OpeningScope, privacyEpoch: number, at: string, restoreCutoffSeq?: number,
): Promise<ContextBlock> {
  await lockMisconceptionContext(tx, scope.workspaceId);
  await tx`SET CONSTRAINTS v3_invalidate_misconception_context IMMEDIATE`;
  await tx`SET CONSTRAINTS v3_invalidate_misconception_context DEFERRED`;
  return writeLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, at, restoreCutoffSeq);
}

function misconceptionContextPages(tx: TransactionSql, scope: OpeningScope, at: string, courseId?: string | null) {
  // Exclude ASCII blanks and controls in SQL. The renderer handles Unicode whitespace across pages.
  const blankSummary = "^[ \u0001-\u001f\u007f-\u009f]*$";
  return tx<ContextRevision[]>`
    SELECT e.status, e.learner_disposition AS "learnerDisposition", e.summary, e.revision_id AS "revisionId", e.course_id AS "courseId"
    FROM v3_bitemporal_misconception_edges e
    JOIN workspaces w ON w.id = e.workspace_id AND w.owner_user_id = e.owner_user_id
    WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
      AND e.privacy_epoch = w.privacy_epoch
      AND (${courseId === undefined} OR e.course_id IS NULL OR e.course_id = ${courseId ?? null}::uuid)
      AND e.valid_range @> ${at}::text::timestamptz AND e.tx_range @> ${at}::text::timestamptz
      AND e.status IN ('candidate', 'verified', 'learner_reported')
      AND e.summary COLLATE "C" !~ ${blankSummary}
    ORDER BY (e.status = 'learner_reported') DESC, lower(e.tx_range) DESC, e.edge_id, e.revision_id`.cursor(64);
}

async function writeLearnerMisconceptionContextBlock(
  tx: TransactionSql, scope: OpeningScope, privacyEpoch: number, at: string, restoreCutoffSeq?: number,
): Promise<ContextBlock> {
  const rendered = { renderedMarkdown: "", byteLength: 0 };
  for await (const items of misconceptionContextPages(tx, scope, at)) {
    if (!appendLearnerContextItems(rendered, items)) break;
  }
  const { renderedMarkdown, byteLength } = rendered;
  const [block] = await tx<ContextBlock[]>`
    INSERT INTO v3_learner_context_blocks
      (workspace_id, owner_user_id, rendered_markdown, byte_length, revision, privacy_epoch, updated_at, restore_cutoff_seq)
    VALUES (${scope.workspaceId}, ${scope.ownerUserId}, ${renderedMarkdown}, ${byteLength}, 1, ${privacyEpoch},
      ${at}::text::timestamptz, ${restoreCutoffSeq ?? null}::bigint)
    ON CONFLICT (workspace_id, owner_user_id) DO UPDATE
    SET rendered_markdown = EXCLUDED.rendered_markdown, byte_length = EXCLUDED.byte_length, invalidated = false,
      revision = v3_learner_context_blocks.revision + 1, privacy_epoch = EXCLUDED.privacy_epoch, updated_at = EXCLUDED.updated_at,
      restore_cutoff_seq = GREATEST(EXCLUDED.restore_cutoff_seq, v3_learner_context_blocks.restore_cutoff_seq)
    RETURNING rendered_markdown AS "renderedMarkdown", byte_length AS "byteLength", revision`;
  return block!;
}

async function readTutorMisconceptionSnapshotInTx(
  tx: TransactionSql, scope: OpeningScope, { courseId, expectedPrivacyEpoch }: {
    courseId: string | null;
    expectedPrivacyEpoch?: number;
  },
): Promise<TutorMisconceptionSnapshot | null> {
  const [workspace] = await tx<{ privacy_epoch: number }[]>`
    SELECT privacy_epoch FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
  if (!workspace) return null;
  const privacyEpoch = workspace.privacy_epoch;
  if (expectedPrivacyEpoch !== undefined && privacyEpoch !== expectedPrivacyEpoch) {
    throw Object.assign(new Error("learner misconception privacy epoch changed"), { code: "PRIVACY_EPOCH_MISMATCH" });
  }
  await lockMisconceptionContext(tx, scope.workspaceId);
  const [clock] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
  const rendered = { renderedMarkdown: "", byteLength: 0 };
  const revisionIds: string[] = [];
  let effectiveCourseId: string | null = null;
  for await (const items of misconceptionContextPages(tx, scope, clock!.at, courseId)) {
    if (!appendLearnerContextItems(rendered, items, item => {
      revisionIds.push(item.revisionId);
      if (item.courseId != null) effectiveCourseId = item.courseId.toLowerCase();
    })) break;
  }
  return { courseId: courseId?.toLowerCase() ?? null, effectiveCourseId, privacyEpoch, revisionIds, ...rendered };
}

export async function readTutorLearnerMisconceptionContext(
  sql: Sql, scope: OpeningScope, input: { courseId: string | null; expectedPrivacyEpoch?: number },
): Promise<TutorMisconceptionSnapshot | null> {
  return sql.begin(tx => readTutorMisconceptionSnapshotInTx(tx, scope, input));
}

export async function assertTutorLearnerMisconceptionSnapshotInTx(
  tx: TransactionSql, scope: OpeningScope, snapshot: TutorMisconceptionSnapshot,
): Promise<void> {
  const current = await readTutorMisconceptionSnapshotInTx(tx, scope, {
    courseId: snapshot.courseId, expectedPrivacyEpoch: snapshot.privacyEpoch,
  });
  if (!current || current.renderedMarkdown !== snapshot.renderedMarkdown
    || (snapshot.effectiveCourseId !== undefined && (snapshot.effectiveCourseId?.toLowerCase() ?? null) !== current.effectiveCourseId)
    || current.revisionIds.length !== snapshot.revisionIds.length
    || current.revisionIds.some((id, index) => id !== snapshot.revisionIds[index])) {
    throw learningError("CONFLICT", "learner misconception context changed");
  }
}

export async function assertTutorLearnerMisconceptionSnapshot(
  sql: Sql, scope: OpeningScope, snapshot: TutorMisconceptionSnapshot,
): Promise<void> {
  await sql.begin(tx => assertTutorLearnerMisconceptionSnapshotInTx(tx, scope, snapshot));
}

export async function readLearnerMisconceptionContextBlock(sql: Sql, scope: OpeningScope): Promise<ContextBlock | null> {
  return sql.begin(async tx => {
    const [workspace] = await tx<{ privacy_epoch: number }[]>`
      SELECT privacy_epoch FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
    if (!workspace) return null;
    // Read revision snapshots without row locks while holding the invalidation lock.
    await lockMisconceptionContext(tx, scope.workspaceId);
    const [clock] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
    const at = clock!.at;
    const [cached] = await tx<ContextBlock[]>`
      SELECT b.rendered_markdown AS "renderedMarkdown", b.byte_length AS "byteLength", b.revision
      FROM v3_learner_context_blocks b
      WHERE b.workspace_id = ${scope.workspaceId} AND b.owner_user_id = ${scope.ownerUserId}
        AND b.privacy_epoch = ${workspace.privacy_epoch}
        AND NOT b.invalidated
        AND b.updated_at <= ${at}::text::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM v3_bitemporal_misconception_edges e
          WHERE e.workspace_id = b.workspace_id AND e.owner_user_id = b.owner_user_id AND e.privacy_epoch = b.privacy_epoch
            AND (e.valid_range @> b.updated_at AND e.tx_range @> b.updated_at) IS DISTINCT FROM
                (e.valid_range @> ${at}::text::timestamptz AND e.tx_range @> ${at}::text::timestamptz)
        )`;
    if (cached) return cached;
    return writeLearnerMisconceptionContextBlock(tx, scope, workspace.privacy_epoch, at);
  });
}

// Bind timestamp text before casting so postgres.js preserves microseconds.
export async function queryMisconceptionEdgesAsOf(
  sql: Sql | TransactionSql,
  scope: OpeningScope,
  { validAt, txAt, courseId, expectedPrivacyEpoch }: {
    validAt: string | Date;
    txAt: string | Date;
    courseId?: string;
    expectedPrivacyEpoch?: number;
  },
): Promise<Edge[]> {
  return sql<Edge[]>`
    SELECT e.revision_id AS "revisionId", e.workspace_id AS "workspaceId", e.owner_user_id AS "ownerUserId",
      e.edge_id AS "edgeId", e.course_id AS "courseId", e.concept_key AS "conceptKey", e.misconception_code AS "misconceptionCode",
      e.summary, e.status, e.origin, e.learner_disposition AS "learnerDisposition", e.evidence_attempt_ids AS "evidenceAttemptIds",
      e.privacy_epoch AS "privacyEpoch", e.valid_range::text AS "validRange", e.tx_range::text AS "txRange",
      CASE WHEN p.privacy_epoch = w.privacy_epoch THEN p.revision_id ELSE NULL END AS "priorRevisionId"
    FROM v3_bitemporal_misconception_edges e
    JOIN workspaces w ON w.id = e.workspace_id AND w.owner_user_id = e.owner_user_id
    LEFT JOIN v3_bitemporal_misconception_edges p ON p.workspace_id = e.workspace_id AND p.owner_user_id = e.owner_user_id
      AND p.edge_id = e.edge_id AND p.revision_id = e.prior_revision_id
    WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
      AND e.valid_range @> ${validAt instanceof Date ? validAt.toISOString() : validAt}::text::timestamptz
      AND e.tx_range @> ${txAt instanceof Date ? txAt.toISOString() : txAt}::text::timestamptz
      AND (${courseId ?? null}::uuid IS NULL OR e.course_id = ${courseId ?? null}::uuid)
      AND e.privacy_epoch = w.privacy_epoch
      AND (${expectedPrivacyEpoch ?? null}::integer IS NULL
        OR w.privacy_epoch = ${expectedPrivacyEpoch ?? null}::integer)
    ORDER BY e.edge_id`;
}

export async function applyLearnerMisconceptionCorrection(sql: Sql, scope: OpeningScope, input: LearnerCorrection) {
  return sql.begin(async tx => {
    const privacyEpoch = await lockMisconceptionWorkspaceForWrite(tx, scope);
    // Protect the successor's course FK before locking any revision rows.
    const [course] = await tx<{ id: string }[]>`
      SELECT c.id FROM courses c
      WHERE c.workspace_id = ${scope.workspaceId} AND c.id IN (
        SELECT e.course_id FROM v3_bitemporal_misconception_edges e
        WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
          AND e.edge_id = ${input.edgeId} AND e.course_id IS NOT NULL
      )
      ORDER BY c.id FOR KEY SHARE OF c`;
    // A direct insert between statements must not introduce a course we did not lock.
    const lockedCourseId = course?.id ?? null;
    // Lock open transaction slices before sampling time while allowing predecessor FK key shares.
    await tx`
      SELECT revision_id FROM v3_bitemporal_misconception_edges
      WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        AND edge_id = ${input.edgeId} AND privacy_epoch = ${privacyEpoch} AND upper_inf(tx_range)
        AND (course_id IS NULL OR course_id = ${lockedCourseId}::uuid)
      ORDER BY revision_id FOR NO KEY UPDATE`;
    const [revision] = await tx<Revision[]>`
      WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at),
      closed AS (
        UPDATE v3_bitemporal_misconception_edges e
        SET tx_range = tstzrange(lower(e.tx_range), GREATEST(tick.at, lower(e.tx_range) + interval '1 microsecond'), '[)')
        FROM tick
        WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
          AND e.edge_id = ${input.edgeId} AND e.privacy_epoch = ${privacyEpoch} AND upper_inf(e.tx_range)
          AND (e.course_id IS NULL OR e.course_id = ${lockedCourseId}::uuid)
          AND e.valid_range @> tick.at
        RETURNING e.*
      )
      INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, course_id, concept_key, misconception_code,
         summary, status, origin, learner_disposition, evidence_attempt_ids, privacy_epoch, valid_range, tx_range, prior_revision_id)
      SELECT ${randomUUID()}, workspace_id, owner_user_id, edge_id, course_id, concept_key, misconception_code,
        ${input.summary}, 'learner_reported', 'learner_correction', ${input.disposition}, evidence_attempt_ids, privacy_epoch,
        valid_range, tstzrange(upper(tx_range), NULL, '[)'), revision_id
      FROM closed
      RETURNING edge_id AS "edgeId", revision_id AS "revisionId", lower(tx_range)::text AS "txAt"`;
    if (!revision) throw learningError("NOT_FOUND", "找不到这条待纠偏的学习记录。");
    const contextBlock = await refreshLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, revision.txAt);
    return { ...revision, status: "learner_reported" as const, disposition: input.disposition, contextBlock };
  });
}

function deriveTryHandoffUuid(kind: "edge" | "initial-revision", identity: string): string {
  const bytes = createHash("sha256").update(`opening:try-misconception:v1:${kind}:${identity.toLowerCase()}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function redeemTryMisconceptionHandoff(sql: Sql, scope: OpeningScope, claim: TryMisconceptionClaim) {
  const edgeId = deriveTryHandoffUuid("edge", claim.receiptId);
  const initialRevisionId = deriveTryHandoffUuid("initial-revision", `${claim.receiptId}:${claim.payloadSha256}`);
  return sql.begin(async tx => {
    const privacyEpoch = await lockMisconceptionWorkspaceForWrite(tx, scope);
    // A receipt can race across independently locked workspaces.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('v3:try-misconception:' || ${claim.receiptId}::uuid::text, 0))`;
    const [clock] = await tx<{ at: string; expired: boolean }[]>`
      WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT at::text, floor(extract(epoch FROM at) * 1000)::bigint >= ${claim.expiresAt}::bigint AS expired FROM tick`;
    if (clock!.expired) throw learningError("CONFLICT", "体验记录已过期。");
    const [prior] = await tx<{
      workspaceId: string | null; edgeId: string | null; revisionId: string | null; claimMatches: boolean; matches: boolean | null;
    }[]>`
      SELECT r.workspace_id AS "workspaceId", r.edge_id AS "edgeId", r.initial_revision_id AS "revisionId",
        (r.original_workspace_id = ${scope.workspaceId} AND r.original_owner_user_id = ${scope.ownerUserId}
          AND r.original_edge_id = ${edgeId} AND r.original_initial_revision_id = ${initialRevisionId}
          AND r.redeemed_privacy_epoch = ${privacyEpoch} AND r.payload_sha256 = ${claim.payloadSha256}) AS "claimMatches",
        (e.privacy_epoch = ${privacyEpoch} AND e.prior_revision_id IS NULL AND e.course_id IS NULL
          AND cardinality(e.evidence_attempt_ids) = 0 AND e.origin = 'public_try_handoff' AND e.status = 'candidate'
          AND e.concept_key = ${claim.conceptKey} AND e.misconception_code = ${claim.misconceptionCode}
          AND e.summary = ${claim.summary}) AS matches
      FROM v3_try_misconception_handoff_receipts r
      LEFT JOIN v3_bitemporal_misconception_edges e ON e.workspace_id = r.workspace_id AND e.owner_user_id = r.owner_user_id
        AND e.edge_id = r.edge_id AND e.revision_id = r.initial_revision_id
      WHERE r.receipt_id = ${claim.receiptId}`;
    if (prior) {
      if (!prior.claimMatches) throw learningError("CONFLICT", "体验记录已被使用。");
      if (prior.workspaceId !== null) {
        if (!prior.matches || prior.edgeId !== edgeId || prior.revisionId !== initialRevisionId) {
          throw learningError("CONFLICT", "体验记录已被使用。");
        }
        return { edgeId, revisionId: initialRevisionId, replayed: true };
      }
    }

    // Look up both identities globally to detect restored revision or edge collisions.
    const [root] = await tx<{ revisionId: string; matches: boolean }[]>`
      SELECT revision_id AS "revisionId",
        (edge_id = ${edgeId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND privacy_epoch = ${privacyEpoch}
          AND prior_revision_id IS NULL AND course_id IS NULL AND cardinality(evidence_attempt_ids) = 0
          AND origin = 'public_try_handoff' AND status = 'candidate' AND concept_key = ${claim.conceptKey}
          AND misconception_code = ${claim.misconceptionCode} AND summary = ${claim.summary}) AS matches
      FROM v3_bitemporal_misconception_edges
      WHERE revision_id = ${initialRevisionId} OR (edge_id = ${edgeId} AND prior_revision_id IS NULL)
      ORDER BY (revision_id = ${initialRevisionId}) DESC, revision_id LIMIT 1`;
    const at = clock!.at;
    if (prior) {
      if (!root?.matches || root.revisionId.toLowerCase() !== initialRevisionId) {
        throw learningError("CONFLICT", "体验记录已被使用。");
      }
      // Hold the existing revision before taking a receipt row lock.
      const [locked] = await tx`
        SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE revision_id = ${initialRevisionId} FOR KEY SHARE`;
      if (!locked) throw learningError("CONFLICT", "体验记录已被使用。");
      const [reattached] = await tx`
        UPDATE v3_try_misconception_handoff_receipts
        SET workspace_id = ${scope.workspaceId}, owner_user_id = ${scope.ownerUserId},
          edge_id = ${edgeId}, initial_revision_id = ${initialRevisionId}, redeemed_at = ${at}::text::timestamptz
        WHERE receipt_id = ${claim.receiptId} AND workspace_id IS NULL
          AND original_workspace_id = ${scope.workspaceId} AND original_owner_user_id = ${scope.ownerUserId}
          AND original_edge_id = ${edgeId} AND original_initial_revision_id = ${initialRevisionId}
          AND redeemed_privacy_epoch = ${privacyEpoch} AND payload_sha256 = ${claim.payloadSha256}
        RETURNING receipt_id`;
      if (!reattached) throw learningError("CONFLICT", "体验记录已被使用。");
      return { edgeId, revisionId: initialRevisionId, replayed: true };
    }

    // An archive root alone cannot establish a server receipt claim.
    if (root) throw learningError("CONFLICT", "体验记录已被使用。");
    // Restore and redemption serialize on the workspace lock, without locking the cache row here.
    const [cutoff] = await tx<{ blocked: boolean }[]>`
      SELECT true AS blocked FROM v3_learner_context_blocks
      WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        AND ${claim.issueSeq}::bigint <= restore_cutoff_seq`;
    if (cutoff?.blocked) throw learningError("CONFLICT", "体验记录已被使用。");
    const [inserted] = await tx`
      INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code, summary, status, origin,
         privacy_epoch, valid_range, tx_range)
      VALUES (${initialRevisionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${claim.conceptKey},
        ${claim.misconceptionCode}, ${claim.summary}, 'candidate', 'public_try_handoff', ${privacyEpoch},
        tstzrange(${at}::text::timestamptz, NULL, '[)'), tstzrange(${at}::text::timestamptz, NULL, '[)'))
      ON CONFLICT DO NOTHING RETURNING revision_id`;
    if (!inserted) throw learningError("CONFLICT", "体验记录已被使用。");
    const [claimed] = await tx`
      INSERT INTO v3_try_misconception_handoff_receipts
        (receipt_id, original_workspace_id, original_owner_user_id, original_edge_id, original_initial_revision_id, redeemed_privacy_epoch,
         workspace_id, owner_user_id, payload_sha256, edge_id, initial_revision_id, redeemed_at)
      VALUES (${claim.receiptId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${initialRevisionId}, ${privacyEpoch},
        ${scope.workspaceId}, ${scope.ownerUserId}, ${claim.payloadSha256}, ${edgeId}, ${initialRevisionId}, ${at}::text::timestamptz)
      ON CONFLICT (receipt_id) DO NOTHING
      RETURNING receipt_id`;
    if (!claimed) throw learningError("CONFLICT", "体验记录已被使用。");
    await refreshLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, at);
    return { edgeId, revisionId: initialRevisionId, replayed: false };
  });
}
