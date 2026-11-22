import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { LEARNER_CONTEXT_MAX_BYTES, type LearnerMisconceptionDisposition, type v3BitemporalMisconceptionEdges } from "../schema/v3-bitemporal-memory";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import type { OpeningScope } from "./opening-sources";

type Edge = typeof v3BitemporalMisconceptionEdges.$inferSelect;
type ContextItem = Pick<Edge, "status" | "learnerDisposition" | "summary">;
type ContextBlock = { renderedMarkdown: string; byteLength: number; revision: number };
type Revision = { edgeId: string; revisionId: string; txAt: string };
type TryMisconceptionClaim = Pick<Edge, "conceptKey" | "misconceptionCode" | "summary"> & {
  receiptId: string;
  payloadSha256: string;
  expiresAt: number;
};
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
  let renderedMarkdown = "";
  let byteLength = 0;
  for (const item of items) {
    if (item.status === "retracted" || item.status === "superseded") continue;
    const text = item.summary.replace(/[\s\p{Cc}]+/gu, " ").trim()
      .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
    if (!text) continue;
    const label = item.learnerDisposition ? dispositionLabels[item.learnerDisposition]
      : item.status === "verified" ? "已确认" : "待确认";
    const prefix = (renderedMarkdown ? "\n- " : "- ") + label + "：";
    const prefixBytes = Buffer.byteLength(prefix);
    const characters: string[] = [];
    let lineBytes = prefixBytes;
    let truncated = false;
    for (const character of text) {
      const literal = "\\`*_{}[]<>()#+-.!|&~".includes(character) ? "\\" + character : character;
      const bytes = Buffer.byteLength(literal);
      if (byteLength + lineBytes + bytes > LEARNER_CONTEXT_MAX_BYTES) {
        truncated = true;
        break;
      }
      characters.push(literal);
      lineBytes += bytes;
    }
    if (characters.length) {
      renderedMarkdown += prefix + characters.join("");
      byteLength += lineBytes;
    }
    if (truncated) break;
  }
  return { renderedMarkdown, byteLength };
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

async function lockMisconceptionContext(tx: TransactionSql, workspaceId: string) {
  // The migration's revision trigger holds this same lock when invalidating the cache.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('v3:learner-context:' || ${workspaceId}::uuid::text, 0))`;
}

/** Call after the final revision mutation, with the workspace lock still held. */
export async function refreshLearnerMisconceptionContextBlock(tx: TransactionSql, scope: OpeningScope, privacyEpoch: number, at: string): Promise<ContextBlock> {
  await lockMisconceptionContext(tx, scope.workspaceId);
  await tx`SET CONSTRAINTS v3_invalidate_misconception_context IMMEDIATE`;
  await tx`SET CONSTRAINTS v3_invalidate_misconception_context DEFERRED`;
  return writeLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, at);
}

async function writeLearnerMisconceptionContextBlock(tx: TransactionSql, scope: OpeningScope, privacyEpoch: number, at: string): Promise<ContextBlock> {
  const items = await tx<ContextItem[]>`
    SELECT status, learner_disposition AS "learnerDisposition", e.summary
    FROM v3_bitemporal_misconception_edges e
    JOIN workspaces w ON w.id = e.workspace_id AND w.owner_user_id = e.owner_user_id
    WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
      AND e.privacy_epoch = w.privacy_epoch
      AND e.valid_range @> ${at}::text::timestamptz AND e.tx_range @> ${at}::text::timestamptz
      AND status IN ('candidate', 'verified', 'learner_reported')
    ORDER BY (status = 'learner_reported') DESC, lower(tx_range) DESC, edge_id
    LIMIT ${LEARNER_CONTEXT_MAX_BYTES}`;
  const { renderedMarkdown, byteLength } = renderLearnerContextBlock(items);
  const [block] = await tx<ContextBlock[]>`
    INSERT INTO v3_learner_context_blocks
      (workspace_id, owner_user_id, rendered_markdown, byte_length, revision, privacy_epoch, updated_at)
    VALUES (${scope.workspaceId}, ${scope.ownerUserId}, ${renderedMarkdown}, ${byteLength}, 1, ${privacyEpoch}, ${at}::text::timestamptz)
    ON CONFLICT (workspace_id, owner_user_id) DO UPDATE
    SET rendered_markdown = EXCLUDED.rendered_markdown, byte_length = EXCLUDED.byte_length, invalidated = false,
      revision = v3_learner_context_blocks.revision + 1, privacy_epoch = EXCLUDED.privacy_epoch, updated_at = EXCLUDED.updated_at
    RETURNING rendered_markdown AS "renderedMarkdown", byte_length AS "byteLength", revision`;
  return block!;
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
      e.prior_revision_id AS "priorRevisionId"
    FROM v3_bitemporal_misconception_edges e
    JOIN workspaces w ON w.id = e.workspace_id AND w.owner_user_id = e.owner_user_id
    WHERE e.workspace_id = ${scope.workspaceId} AND e.owner_user_id = ${scope.ownerUserId}
      AND e.valid_range @> ${validAt instanceof Date ? validAt.toISOString() : validAt}::text::timestamptz
      AND e.tx_range @> ${txAt instanceof Date ? txAt.toISOString() : txAt}::text::timestamptz
      AND (${courseId ?? null}::uuid IS NULL OR e.course_id = ${courseId ?? null}::uuid)
      AND (${expectedPrivacyEpoch ?? null}::integer IS NULL
        OR (w.privacy_epoch = ${expectedPrivacyEpoch ?? null}::integer AND e.privacy_epoch = w.privacy_epoch))
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
  return sql.begin(async tx => {
    const privacyEpoch = await lockMisconceptionWorkspaceForWrite(tx, scope);
    // A receipt can race across independently locked workspaces.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('v3:try-misconception:' || ${claim.receiptId}::uuid::text, 0))`;
    const [clock] = await tx<{ at: string; expired: boolean }[]>`
      WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT at::text, at >= to_timestamp(${claim.expiresAt}::double precision / 1000) AS expired FROM tick`;
    if (clock!.expired) throw learningError("CONFLICT", "体验记录已过期。");
    const [prior] = await tx<{ edgeId: string; revisionId: string; matches: boolean }[]>`
      SELECT edge_id AS "edgeId", initial_revision_id AS "revisionId",
        (workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND payload_sha256 = ${claim.payloadSha256}) AS matches
      FROM v3_try_misconception_handoff_receipts WHERE receipt_id = ${claim.receiptId}`;
    if (prior) {
      if (!prior.matches) throw learningError("CONFLICT", "体验记录已被使用。");
      return { edgeId: prior.edgeId, revisionId: prior.revisionId, replayed: true };
    }

    const edgeId = deriveTryHandoffUuid("edge", claim.receiptId);
    const initialRevisionId = deriveTryHandoffUuid("initial-revision", `${claim.receiptId}:${claim.payloadSha256}`);
    // Backups retain revisions and omit the receipt ledger. Look up both identities
    // globally so a restored revision attached to another edge is still a conflict.
    const [root] = await tx<{ revisionId: string; matches: boolean }[]>`
      SELECT revision_id AS "revisionId",
        (edge_id = ${edgeId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND prior_revision_id IS NULL AND course_id IS NULL AND cardinality(evidence_attempt_ids) = 0
          AND origin = 'public_try_handoff' AND status = 'candidate' AND concept_key = ${claim.conceptKey}
          AND misconception_code = ${claim.misconceptionCode} AND summary = ${claim.summary}) AS matches
      FROM v3_bitemporal_misconception_edges
      WHERE revision_id = ${initialRevisionId} OR (edge_id = ${edgeId} AND prior_revision_id IS NULL)
      ORDER BY (revision_id = ${initialRevisionId}) DESC, revision_id LIMIT 1`;
    if (root && (!root.matches || root.revisionId.toLowerCase() !== initialRevisionId)) {
      throw learningError("CONFLICT", "体验记录已被使用。");
    }
    const at = clock!.at;
    if (!root) {
      const [inserted] = await tx`
        INSERT INTO v3_bitemporal_misconception_edges
          (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code, summary, status, origin,
           privacy_epoch, valid_range, tx_range)
        VALUES (${initialRevisionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${claim.conceptKey},
          ${claim.misconceptionCode}, ${claim.summary}, 'candidate', 'public_try_handoff', ${privacyEpoch},
          tstzrange(${at}::text::timestamptz, NULL, '[)'), tstzrange(${at}::text::timestamptz, NULL, '[)'))
        ON CONFLICT DO NOTHING RETURNING revision_id`;
      if (!inserted) throw learningError("CONFLICT", "体验记录已被使用。");
    }
    const [claimed] = await tx`
      INSERT INTO v3_try_misconception_handoff_receipts
        (receipt_id, workspace_id, owner_user_id, payload_sha256, edge_id, initial_revision_id, redeemed_at)
      VALUES (${claim.receiptId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${claim.payloadSha256},
        ${edgeId}, ${initialRevisionId}, ${at}::text::timestamptz)
      ON CONFLICT (receipt_id) DO NOTHING RETURNING receipt_id`;
    if (!claimed) throw learningError("CONFLICT", "体验记录已被使用。");
    if (!root) await refreshLearnerMisconceptionContextBlock(tx, scope, privacyEpoch, at);
    return { edgeId, revisionId: initialRevisionId, replayed: Boolean(root) };
  });
}
