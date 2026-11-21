import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import {
  examWorkReviewInputSchema, examWorkReviewProposalSchema, uuidSchema,
  type ExamWorkReview, type ExamWorkReviewInput, type ExamWorkReviewProposal, type Scope,
} from "@aistudy/contracts";
import { learningError } from "./opening-learning-facts";
import { assertExamMaterialAvailable } from "./opening-exam-integration-binding";
import { parseExamBinding, readCommittedExamReceipt } from "./opening-exam-integration-facts";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

type Row = Record<string, unknown>;
export type ExamReviewContext = {
  review: ExamWorkReview; input: ExamWorkReviewInput; privacyEpoch: number;
  referencePage: number; questionLabel: string; reusedUnresolved?: boolean;
  executionUpdatedAt?: string;
};
// Exceeds the 200-char clientKey ceiling of bind/mapSource so review aliases cannot collide in opening_exam_integration_commands.
const REVIEW_ALIAS_KEY_PREFIX = `exam-review-alias:v1:${"_".repeat(180)}:`;
const reviewAliasKey = (clientKey: string) => `${REVIEW_ALIAS_KEY_PREFIX}${clientKey}`;
// Exceeds the integration command clientKey ceiling and remains disjoint from review aliases.
const SUPERSEDED_REVIEW_KEY_PREFIX = `exam-review-superseded:v1:${"_".repeat(180)}:`;
const supersededReviewKey = (reviewId: string) => `${SUPERSEDED_REVIEW_KEY_PREFIX}${reviewId}`;
const STALE_PENDING_LEASE_SECONDS = 60;
const reviewOperationId = (workspaceId: string, reviewId: string) => `exam-review:${workspaceId}:${reviewId}`;
const examReviewAliasSchema = z.object({
  reviewId: uuidSchema,
}).strict();
type ExamReviewAlias = z.infer<typeof examReviewAliasSchema>;

function reviewIntentBody(input: ExamWorkReviewInput) {
  const { clientKey: _clientKey, ...body } = input;
  return body;
}

function epochExpiredError() {
  return Object.assign(
    learningError("CONFLICT", "材料隐私设置已变化，请重新选择材料"),
    { businessCode: "EXAM_REVIEW_EPOCH_EXPIRED" as const },
  );
}
function view(row: Row): ExamWorkReview {
  return { id: String(row.id), sourceItemId: String(row.source_item_id), workSourceId: String(row.work_source_id),
    referenceSourceId: String(row.reference_source_id), createdAt: new Date(row.created_at as Date).toISOString(),
    workSourceVersion: Number(row.work_source_version), referenceSourceVersion: Number(row.reference_source_version), answerText: String(row.answer_text),
    status: row.status as ExamWorkReview["status"], modelLabel: row.model_label as string | null,
    proposal: row.proposal == null ? null : examWorkReviewProposalSchema.parse(row.proposal) };
}

/** Images stay in object storage. Only a proposal is retained; it cannot grade an observation. */
export function createOpeningExamReviewsRepository(sql: Sql) {
  async function validate(tx: TransactionSql, scope: Scope, input: ExamWorkReviewInput, expectedEpoch?: number) {
    const [workspace] = await tx`SELECT id,privacy_epoch FROM workspaces
      WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!workspace) throw learningError("NOT_FOUND", "工作区不存在");
    const privacyEpoch = Number(workspace.privacy_epoch);
    if (expectedEpoch !== undefined && expectedEpoch !== privacyEpoch) throw epochExpiredError();
    const [row] = await tx`SELECT s.id,s.pack_snapshot,s.state,b.binding FROM opening_exam_sprints s
      JOIN opening_exam_bindings b ON b.sprint_id=s.id
      WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} FOR SHARE OF s,b`;
    if (!row) throw learningError("CONFLICT", "请先将冲刺绑定课程和原材料");
    const snapshot = parseExamSprintSnapshot(row.pack_snapshot, row.state), binding = parseExamBinding(row.binding);
    const courses = await tx`SELECT id FROM courses WHERE id=${binding.courseId} AND workspace_id=${scope.workspaceId}
      AND archived_at IS NULL FOR SHARE`;
    if (!courses.length) throw learningError("CONFLICT", "课程已归档，请先恢复课程再评阅");
    const item = snapshot.pack.sourceItems.find(item => item.id === input.sourceItemId);
    const reference = item && binding.materials.find(material => material.sourceTitle === item.sourceTitle);
    if (!item || !item.sourcePage || !reference || reference.sourceId !== input.referenceSourceId
      || reference.sourceVersion !== input.referenceSourceVersion) throw learningError("CONFLICT", "请先绑定这道原题的真实材料及页码");
    if (input.workSourceId === input.referenceSourceId || binding.materials.some(material => material.sourceId === input.workSourceId)
      || binding.packSourceId === input.workSourceId) throw learningError("VALIDATION", "请选择自己的作答照片作为作答材料");
    for (const [id, version] of [[input.workSourceId, input.workSourceVersion], [input.referenceSourceId, input.referenceSourceVersion]] as const) {
      await assertExamMaterialAvailable(tx, scope, id, version);
      const [current] = await tx`SELECT version FROM opening_sources WHERE id=${id}`;
      if (Number(current?.version) !== version) throw learningError("CONFLICT", "材料已更新，请刷新到当前版本");
    }
    const [work] = await tx`SELECT mime FROM opening_sources WHERE id=${input.workSourceId}`;
    if (!["image/jpeg", "image/png", "image/webp"].includes(String(work?.mime))) throw learningError("VALIDATION", "作答材料请选择已上传的 JPG、PNG 或 WebP 照片");
    const pages = await tx`SELECT 1 FROM opening_source_chunks WHERE source_id=${reference.sourceId}
      AND source_version=${reference.sourceVersion} AND page=${item.sourcePage}
      AND (text ~ '[^[:space:]]' OR (image_object_key IS NOT NULL AND image_object_key<>'')) LIMIT 1`;
    if (!pages.length) throw learningError("CONFLICT", "原材料中找不到这道题对应的物理页");
    return { sprintId: String(row.id), privacyEpoch, referencePage: item.sourcePage,
      questionLabel: `${item.sourceTitle}，物理页 ${item.sourcePage}，${item.label}` };
  }
  async function readContext(tx: TransactionSql, scope: Scope, id: string): Promise<ExamReviewContext> {
    const [row] = await tx`SELECT * FROM opening_exam_reviews WHERE id=${id}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!row) throw learningError("NOT_FOUND", "评阅记录不存在");
    const input = examWorkReviewInputSchema.parse(row.intent);
    const checked = await validate(tx, scope, input, Number(row.privacy_epoch));
    return {
      review: view(row), input, privacyEpoch: checked.privacyEpoch,
      referencePage: checked.referencePage, questionLabel: checked.questionLabel,
    };
  }
  async function inspectReviewLedger(
    tx: TransactionSql,
    workspaceId: string,
    reviewId: string,
  ): Promise<"none" | "released_only" | "active_or_billed"> {
    const operationId = reviewOperationId(workspaceId, reviewId);
    const rows = await tx`SELECT state, release_reason, outcome_unknown_at, pending_reconcile_cents
      FROM opening_budget_reservations
      WHERE workspace_id=${workspaceId}
        AND (
          request_id=${operationId}
          OR left(request_id, length(${operationId}) + 1)=${`${operationId}:`}
          OR parent_interaction_id=${operationId}
        )
      ORDER BY id
      FOR UPDATE`;
    if (!rows.length) return "none";
    const allReleasedNotSent = rows.every(row =>
      row.state === "released"
      && (row.release_reason === "not_sent" || row.release_reason === "cancelled")
      && row.outcome_unknown_at == null
      && Number(row.pending_reconcile_cents ?? 0) === 0,
    );
    return allReleasedNotSent ? "released_only" : "active_or_billed";
  }

  async function pointToWinner(tx: TransactionSql, row: Row, chosenId: string) {
    const rowId = String(row.id);
    if (rowId === chosenId) return;
    const sprintId = String(row.sprint_id);
    const alias: ExamReviewAlias = { reviewId: chosenId };
    await tx`INSERT INTO opening_exam_integration_commands(id,sprint_id,client_key,intent,recorded_at)
      VALUES(${randomUUID()},${sprintId},${supersededReviewKey(rowId)},${tx.json(alias)},now())
      ON CONFLICT (sprint_id,client_key) DO UPDATE SET intent=EXCLUDED.intent, recorded_at=now()`;
    for (const prefix of [REVIEW_ALIAS_KEY_PREFIX, SUPERSEDED_REVIEW_KEY_PREFIX]) {
      await tx`UPDATE opening_exam_integration_commands
        SET intent=${tx.json(alias)}, recorded_at=now()
        WHERE sprint_id=${sprintId}
          AND left(client_key, length(${prefix}))=${prefix}
          AND intent->>'reviewId'=${rowId}`;
    }
  }

  async function reconcileSameIntentRows(
    tx: TransactionSql,
    scope: Scope,
    rows: Row[],
    options: {
      wrapCommittedReceipt: boolean;
      preferredRowId?: string;
    },
  ): Promise<{ context: ExamReviewContext; chosenId: string } | null> {
    if (!rows.length) return null;
    const load = (id: string) => options.wrapCommittedReceipt
      ? readCommittedExamReceipt(() => readContext(tx, scope, id))
      : readContext(tx, scope, id);
    const sortByCreatedThenId = (a: Row, b: Row) => {
      const aTime = new Date(a.created_at as string | Date).getTime();
      const bTime = new Date(b.created_at as string | Date).getTime();
      return aTime !== bTime ? aTime - bTime : String(a.id).localeCompare(String(b.id));
    };
    const readyRows: Row[] = [];
    const blockingRows: Row[] = [];
    const reclaimableRows: Row[] = [];
    const releasedStaleRows: Row[] = [];
    for (const row of rows) {
      const rowId = String(row.id);
      if (row.status === "ready") {
        readyRows.push(row);
      } else if (row.status === "unknown") {
        if (row.is_stale) {
          const ledger = await inspectReviewLedger(tx, scope.workspaceId, rowId);
          // Only a positive released_only receipt proves zero spend. Missing ledger rows
          // (e.g. after Backup v2 restore, which omits opening_budget_reservations) MUST stay unknown.
          if (ledger === "released_only") {
            releasedStaleRows.push(row);
            continue;
          }
        }
        blockingRows.push(row);
      } else if (row.status === "pending") {
        if (!row.is_stale) {
          blockingRows.push(row);
        } else {
          const ledger = await inspectReviewLedger(tx, scope.workspaceId, rowId);
          if (ledger === "released_only") {
            releasedStaleRows.push(row);
            continue;
          }
          if (ledger === "active_or_billed") {
            // Preserve updated_at so the in-flight worker's lease still matches if it later
            // confirms a no-charge release, and stale-unknown recovery stays eligible once released.
            await tx`UPDATE opening_exam_reviews SET status='unknown'
              WHERE id=${rowId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending'`;
            blockingRows.push(row);
          } else {
            reclaimableRows.push(row);
          }
        }
      }
    }
    const supersedeRows = async (superseded: Row[], chosenId: string) => {
      for (const row of superseded) {
        const rowId = String(row.id);
        if (rowId === chosenId) continue;
        await tx`UPDATE opening_exam_reviews
          SET status='failed',
              updated_at=GREATEST(now(), updated_at + interval '1 microsecond')
          WHERE id=${rowId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND status IN ('pending', 'unknown')`;
        await pointToWinner(tx, row, chosenId);
      }
    };
    const pick = (bucket: Row[]) => {
      if (options.preferredRowId) {
        const preferred = bucket.find(row => String(row.id) === options.preferredRowId);
        if (preferred) return preferred;
      }
      return bucket.sort(sortByCreatedThenId)[0]!;
    };
    if (readyRows.length) {
      const chosenId = String(readyRows.sort(sortByCreatedThenId)[0]!.id);
      const context = await load(chosenId);
      await supersedeRows([...releasedStaleRows, ...reclaimableRows], chosenId);
      for (const row of blockingRows) {
        if (row.status === "pending") {
          await tx`UPDATE opening_exam_reviews SET status='unknown'
            WHERE id=${String(row.id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending'`;
        }
        await pointToWinner(tx, row, chosenId);
      }
      return { context, chosenId };
    }
    if (blockingRows.length) {
      const chosenId = String(pick(blockingRows).id);
      const context = await load(chosenId);
      await supersedeRows([...releasedStaleRows, ...reclaimableRows], chosenId);
      return { context: { ...context, reusedUnresolved: true }, chosenId };
    }
    if (reclaimableRows.length) {
      const chosenId = String(pick(reclaimableRows).id);
      const context = await load(chosenId);
      await supersedeRows([...releasedStaleRows, ...reclaimableRows], chosenId);
      const [reclaimed] = await tx`UPDATE opening_exam_reviews
        SET updated_at=GREATEST(now(), updated_at + interval '1 microsecond')
        WHERE id=${chosenId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending'
        RETURNING updated_at::text AS lease_updated_at`;
      return {
        chosenId,
        context: {
          ...context,
          ...(typeof reclaimed?.lease_updated_at === "string" ? { executionUpdatedAt: reclaimed.lease_updated_at } : {}),
        },
      };
    }
    for (const row of releasedStaleRows) {
      await tx`UPDATE opening_exam_reviews
        SET status='failed', updated_at=GREATEST(now(), updated_at + interval '1 microsecond')
        WHERE id=${String(row.id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND status IN ('pending', 'unknown')`;
    }
    return null;
  }

  return {
    async begin(scope: Scope, raw: ExamWorkReviewInput): Promise<ExamReviewContext> {
      const input = examWorkReviewInputSchema.parse(raw);
      let staleAlias: { id: string; sprintId: string; reviewId: string } | null = null;
      try {
        return await sql.begin(async tx => {
          // Serializes logical operation creation. No learning-history mutation occurs here.
          const [owner] = await tx`SELECT id,privacy_epoch FROM workspaces WHERE id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
          if (!owner) throw learningError("NOT_FOUND", "工作区不存在");
          const workspacePrivacyEpoch = Number(owner.privacy_epoch);
          const [aliasRow] = await tx`SELECT c.id,c.sprint_id,c.intent FROM opening_exam_integration_commands c
            JOIN opening_exam_sprints s ON s.id=c.sprint_id
            WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
              AND c.client_key=${reviewAliasKey(input.clientKey)} LIMIT 1`;
          let aliasTarget: { id: string; sprintId: string; reviewId: string } | null = null;
          if (aliasRow) {
            const parsed = examReviewAliasSchema.safeParse(aliasRow.intent);
            if (!parsed.success) throw learningError("CONFLICT", "评阅记录无法校验，请保留数据并联系维护者");
            aliasTarget = {
              id: String(aliasRow.id),
              sprintId: String(aliasRow.sprint_id),
              reviewId: parsed.data.reviewId,
            };
          }
          // Lock the caller's clientKey row, alias target, and ALL non-failed same-intent rows in one
          // canonical id ASC query so original/alias retries cannot reclaim stale row A while sibling B is ready/active/unknown.
          const lockedRows = await tx`SELECT *, (updated_at <= now() - make_interval(secs => ${STALE_PENDING_LEASE_SECONDS})) AS is_stale
            FROM opening_exam_reviews
            WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
              AND (
                client_key=${input.clientKey}
                ${aliasTarget ? tx`OR (id=${aliasTarget.reviewId} AND sprint_id=${aliasTarget.sprintId})` : tx``}
                OR EXISTS (
                  SELECT 1 FROM opening_exam_reviews original
                  JOIN opening_exam_integration_commands c ON c.sprint_id=original.sprint_id
                    AND c.client_key=(${SUPERSEDED_REVIEW_KEY_PREFIX} || original.id::text)
                  WHERE original.workspace_id=${scope.workspaceId} AND original.owner_user_id=${scope.ownerUserId}
                    AND original.client_key=${input.clientKey} AND c.intent->>'reviewId'=opening_exam_reviews.id::text
                    AND original.sprint_id=opening_exam_reviews.sprint_id
                )
                OR (
                  source_item_id=${input.sourceItemId}
                  AND work_source_id=${input.workSourceId} AND work_source_version=${input.workSourceVersion}
                  AND reference_source_id=${input.referenceSourceId} AND reference_source_version=${input.referenceSourceVersion}
                  AND privacy_epoch=${workspacePrivacyEpoch} AND answer_text=${input.answerText}
                  AND status IN ('pending', 'unknown', 'ready')
                )
              )
            ORDER BY id ASC
            FOR UPDATE`;
          const matchesSameIntent = (row: Row, sprintId: string) =>
            String(row.sprint_id) === sprintId
            && String(row.source_item_id) === input.sourceItemId
            && String(row.work_source_id) === input.workSourceId
            && Number(row.work_source_version) === input.workSourceVersion
            && String(row.reference_source_id) === input.referenceSourceId
            && Number(row.reference_source_version) === input.referenceSourceVersion
            && Number(row.privacy_epoch) === workspacePrivacyEpoch
            && String(row.answer_text) === input.answerText
            && (row.status === "pending" || row.status === "unknown" || row.status === "ready");
          const existing = lockedRows.find(row => row.client_key === input.clientKey);
          if (existing) {
            if (!isDeepStrictEqual(existing.intent, input)) throw learningError("CONFLICT", "同一评阅标识不能提交不同作答");
            if (Number(existing.privacy_epoch) !== workspacePrivacyEpoch) throw epochExpiredError();
            const existingId = String(existing.id);
            let preferredId = existingId;
            const [pointer] = await tx`SELECT c.id,c.sprint_id,c.intent FROM opening_exam_integration_commands c
                JOIN opening_exam_sprints s ON s.id=c.sprint_id
                WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
                  AND c.client_key=${supersededReviewKey(existingId)} AND c.sprint_id=${String(existing.sprint_id)} LIMIT 1`;
            if (!pointer && existing.status === "failed") return await readCommittedExamReceipt(() => readContext(tx, scope, existingId));
            if (pointer) {
              const parsed = examReviewAliasSchema.safeParse(pointer.intent);
              const target = parsed.success && lockedRows.find(row => String(row.id) === parsed.data.reviewId
                && String(row.sprint_id) === String(existing.sprint_id));
              if (!target) throw learningError("CONFLICT", "评阅记录无法校验，请保留数据并联系维护者");
              const targetIntent = examWorkReviewInputSchema.safeParse(target.intent);
              if (!targetIntent.success || !isDeepStrictEqual(reviewIntentBody(targetIntent.data), reviewIntentBody(input))
                || Number(target.privacy_epoch) !== workspacePrivacyEpoch) {
                throw learningError("CONFLICT", "评阅记录无法校验，请保留数据并联系维护者");
              }
              preferredId = String(target.id);
              if (target.status === "failed") return await readCommittedExamReceipt(() => readContext(tx, scope, preferredId));
            }
            const sameIntent = lockedRows.filter(row => matchesSameIntent(row, String(existing.sprint_id)));
            const reconciled = await reconcileSameIntentRows(tx, scope, sameIntent, {
              wrapCommittedReceipt: true,
              preferredRowId: preferredId,
            });
            return reconciled
              ? reconciled.context
              : await readCommittedExamReceipt(() => readContext(tx, scope, preferredId));
          }
          if (aliasTarget) {
            const target = lockedRows.find(
              row => String(row.id) === aliasTarget.reviewId && String(row.sprint_id) === aliasTarget.sprintId,
            );
            if (!target) {
              staleAlias = aliasTarget;
              await tx`DELETE FROM opening_exam_integration_commands WHERE id=${aliasTarget.id}`;
            } else {
              const targetIntent = examWorkReviewInputSchema.safeParse(target.intent);
              if (!targetIntent.success) throw learningError("CONFLICT", "评阅记录无法校验，请保留数据并联系维护者");
              if (!isDeepStrictEqual(reviewIntentBody(targetIntent.data), reviewIntentBody(input))) {
                throw learningError("CONFLICT", "同一评阅标识不能提交不同作答");
              }
              if (Number(target.privacy_epoch) !== workspacePrivacyEpoch) throw epochExpiredError();
              const targetId = String(target.id);
              if (target.status === "failed") {
                return await readCommittedExamReceipt(() => readContext(tx, scope, targetId));
              }
              const sameIntent = lockedRows.filter(row => matchesSameIntent(row, String(target.sprint_id)));
              const reconciled = await reconcileSameIntentRows(tx, scope, sameIntent, {
                wrapCommittedReceipt: true,
                preferredRowId: targetId,
              });
              return reconciled
                ? reconciled.context
                : await readCommittedExamReceipt(() => readContext(tx, scope, targetId));
            }
          }
          const checked = await validate(tx, scope, input), id = randomUUID();
          const sameIntent = lockedRows.filter(row => matchesSameIntent(row, checked.sprintId));
          const reconciled = await reconcileSameIntentRows(tx, scope, sameIntent, { wrapCommittedReceipt: false });
          if (reconciled) {
            const alias: ExamReviewAlias = { reviewId: reconciled.chosenId };
            await tx`INSERT INTO opening_exam_integration_commands(id,sprint_id,client_key,intent,recorded_at)
              VALUES(${randomUUID()},${checked.sprintId},${reviewAliasKey(input.clientKey)},${tx.json(alias)},now())
              ON CONFLICT (sprint_id,client_key) DO UPDATE SET intent=EXCLUDED.intent, recorded_at=now()`;
            return reconciled.context;
          }
          const [inserted] = await tx`INSERT INTO opening_exam_reviews(id,sprint_id,workspace_id,owner_user_id,source_item_id,
            work_source_id,work_source_version,reference_source_id,reference_source_version,answer_text,
            client_key,intent,status,privacy_epoch)
            VALUES(${id},${checked.sprintId},${scope.workspaceId},${scope.ownerUserId},${input.sourceItemId},
            ${input.workSourceId},${input.workSourceVersion},${input.referenceSourceId},${input.referenceSourceVersion},
            ${input.answerText},${input.clientKey},${tx.json(input)},'pending',${checked.privacyEpoch})
            RETURNING updated_at::text AS lease_updated_at`;
          const context = await readContext(tx, scope, id);
          return {
            ...context,
            ...(typeof inserted?.lease_updated_at === "string" ? { executionUpdatedAt: inserted.lease_updated_at } : {}),
          };
        });
      } catch (error) {
        if (staleAlias) {
          const { id, sprintId, reviewId } = staleAlias;
          try {
            await sql`DELETE FROM opening_exam_integration_commands c
              USING opening_exam_sprints s
              WHERE c.id=${id} AND c.sprint_id=${sprintId} AND s.id=c.sprint_id
                AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
                AND c.client_key=${reviewAliasKey(input.clientKey)}
                AND NOT EXISTS (
                  SELECT 1 FROM opening_exam_reviews r
                  WHERE r.id=${reviewId} AND r.sprint_id=c.sprint_id
                    AND r.workspace_id=s.workspace_id AND r.owner_user_id=s.owner_user_id
                )`;
          } catch {
            // Preserve the original validation error if best-effort cleanup fails.
          }
        }
        throw error;
      }
    },
    async read(scope: Scope, id: string): Promise<ExamWorkReview> {
      return sql.begin(async tx => {
        const original = await readContext(tx, scope, id);
        let current = original;
        const visited = new Set([id]);
        for (let hop = 0; hop < 8; hop++) {
          const [pointer] = await tx`SELECT c.intent FROM opening_exam_integration_commands c
            JOIN opening_exam_reviews source ON source.sprint_id=c.sprint_id
            JOIN opening_exam_sprints sprint ON sprint.id=c.sprint_id
            WHERE source.id=${current.review.id} AND source.workspace_id=${scope.workspaceId}
              AND source.owner_user_id=${scope.ownerUserId}
              AND sprint.workspace_id=${scope.workspaceId} AND sprint.owner_user_id=${scope.ownerUserId}
              AND c.client_key=${supersededReviewKey(current.review.id)} LIMIT 1`;
          if (!pointer) return current.review;
          const parsed = examReviewAliasSchema.safeParse(pointer.intent);
          if (!parsed.success || visited.has(parsed.data.reviewId)) return original.review;
          const [target] = await tx`SELECT target.intent, target.privacy_epoch, target.proposal FROM opening_exam_reviews target
            JOIN opening_exam_reviews source ON source.id=${id}
              AND target.sprint_id=source.sprint_id AND target.workspace_id=source.workspace_id
              AND target.owner_user_id=source.owner_user_id AND target.source_item_id=source.source_item_id
              AND target.work_source_id=source.work_source_id AND target.work_source_version=source.work_source_version
              AND target.reference_source_id=source.reference_source_id AND target.reference_source_version=source.reference_source_version
              AND target.privacy_epoch=source.privacy_epoch AND target.answer_text=source.answer_text
            WHERE source.workspace_id=${scope.workspaceId} AND source.owner_user_id=${scope.ownerUserId}
              AND target.id=${parsed.data.reviewId}`;
          const targetInput = target && examWorkReviewInputSchema.safeParse(target.intent);
          if (!targetInput || !targetInput.success
            || Number(target.privacy_epoch) !== original.privacyEpoch
            || (target.proposal != null && !examWorkReviewProposalSchema.safeParse(target.proposal).success)
            || !isDeepStrictEqual(reviewIntentBody(targetInput.data), reviewIntentBody(original.input))) return original.review;
          visited.add(parsed.data.reviewId);
          current = await readContext(tx, scope, parsed.data.reviewId);
        }
        return original.review;
      });
    },
    async assertCurrent(scope: Scope, id: string, expectedUpdatedAt?: string): Promise<void> {
      await sql.begin(async tx => {
        await readContext(tx, scope, id);
        const [active] = await tx`SELECT id FROM opening_exam_reviews
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
            AND status='pending'
            ${expectedUpdatedAt ? tx`AND updated_at=(${expectedUpdatedAt}::text)::timestamptz` : tx``}
          FOR SHARE`;
        if (!active) throw learningError("CONFLICT", "评阅状态已变化，本次尝试已中止");
      });
    },
    async complete(scope: Scope, id: string, raw: ExamWorkReviewProposal, modelLabel: string | null): Promise<void> {
      const proposal = examWorkReviewProposalSchema.parse(raw);
      await sql.begin(async tx => {
        // Use the same workspace serialization as begin before acquiring review locks.
        const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner) throw learningError("NOT_FOUND", "工作区不存在");
        await readContext(tx, scope, id);
        const rows = await tx`SELECT r.* FROM opening_exam_reviews r
          WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}
            AND EXISTS (SELECT 1 FROM opening_exam_reviews original
              WHERE original.id=${id} AND original.workspace_id=r.workspace_id AND original.owner_user_id=r.owner_user_id
                AND original.sprint_id=r.sprint_id AND original.source_item_id=r.source_item_id
                AND original.work_source_id=r.work_source_id AND original.work_source_version=r.work_source_version
                AND original.reference_source_id=r.reference_source_id AND original.reference_source_version=r.reference_source_version
                AND original.privacy_epoch=r.privacy_epoch AND original.answer_text=r.answer_text)
          ORDER BY r.id ASC FOR UPDATE OF r`;
        const current = rows.find(row => String(row.id) === id);
        if (!current || (current.status !== "pending" && current.status !== "unknown")) return;
        const [pointer] = await tx`SELECT c.id,c.sprint_id,c.intent FROM opening_exam_integration_commands c
          JOIN opening_exam_sprints s ON s.id=c.sprint_id
          WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
            AND c.client_key=${supersededReviewKey(id)} AND c.sprint_id=${String(current.sprint_id)} LIMIT 1`;
        if (pointer) {
          if (!examReviewAliasSchema.safeParse(pointer.intent).success) {
            throw learningError("CONFLICT", "评阅记录无法校验，请保留数据并联系维护者");
          }
          return;
        }
        const ready = rows.filter(row => row.status === "ready")
          .sort((a, b) => new Date(a.created_at as Date).getTime() - new Date(b.created_at as Date).getTime()
            || String(a.id).localeCompare(String(b.id)))[0];
        const chosenId = ready ? String(ready.id) : id;
        if (!ready) {
          await tx`UPDATE opening_exam_reviews SET status='ready',proposal=${tx.json(proposal)},model_label=${modelLabel},updated_at=now()
            WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status IN ('pending', 'unknown')`;
        }
        for (const row of rows) {
          if (String(row.id) === chosenId || (row.status !== "pending" && row.status !== "unknown")) continue;
          if (row.status === "pending") {
            await tx`UPDATE opening_exam_reviews SET status='unknown'
              WHERE id=${String(row.id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending'`;
          }
          await pointToWinner(tx, row, chosenId);
        }
      });
    },
    async fail(scope: Scope, id: string, status: "unknown" | "failed", expectedUpdatedAt?: string): Promise<void> {
      const operationId = reviewOperationId(scope.workspaceId, id);
      const allowedStatuses = status === "failed" && expectedUpdatedAt
        ? sql`AND (
            status='pending'
            OR (
              status='unknown'
              AND EXISTS (
                SELECT 1 FROM opening_budget_reservations r
                WHERE r.workspace_id=${scope.workspaceId}
                  AND (
                    r.request_id=${operationId}
                    OR left(r.request_id, length(${operationId}) + 1)=${`${operationId}:`}
                    OR r.parent_interaction_id=${operationId}
                  )
                  AND r.state='released'
                  AND r.release_reason IS NOT NULL
                  AND r.release_reason IN ('not_sent','cancelled')
                  AND r.outcome_unknown_at IS NULL
                  AND COALESCE(r.pending_reconcile_cents,0)=0
              )
            )
          )`
        : sql`AND status='pending'`;
      await sql`UPDATE opening_exam_reviews
        SET status=${status}, updated_at=GREATEST(now(), updated_at + interval '1 microsecond')
        WHERE id=${id}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          ${allowedStatuses}
          ${expectedUpdatedAt ? sql`AND updated_at=(${expectedUpdatedAt}::text)::timestamptz` : sql``}
          ${status === "failed" ? sql`AND NOT EXISTS (
            SELECT 1 FROM opening_budget_reservations b
            WHERE b.workspace_id=${scope.workspaceId}
              AND (
                b.request_id=${operationId}
                OR left(b.request_id, length(${operationId}) + 1)=${`${operationId}:`}
                OR b.parent_interaction_id=${operationId}
              )
              AND (
                b.state='released'
                AND b.release_reason IS NOT NULL
                AND b.release_reason IN ('not_sent','cancelled')
                AND b.outcome_unknown_at IS NULL
                AND COALESCE(b.pending_reconcile_cents,0)=0
              ) IS NOT TRUE
          )` : sql``}`;
    },
  };
}
