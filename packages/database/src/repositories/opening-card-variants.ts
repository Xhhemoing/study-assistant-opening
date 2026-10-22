import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { cardReviewKind, cardVariantProposalSchema, type CardVariantReview, type Scope } from "@aistudy/contracts";
import { checkArithmeticAnswer } from "@aistudy/domain";
import { admitLearningSources, learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { loadCard, loadReviewStateForUpdate, lockCardForUpdate } from "./cards-ops";
import { createOpeningTeachingActivitiesRepository, mapTeachingActivity } from "./opening-teaching-activities";
import { createOpeningTeachingContentRepository } from "./opening-teaching-content";
import { proposalTransactionClient } from "./opening-assistant-proposal-effects";

const questionText = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").replace(/^[\d一二三四五六七八九]+[.、)）]/, "");
const conflict = (message: string) => learningError("CONFLICT", message);

async function cardContext(tx: TransactionSql, scope: Scope, cardId: string) {
  await lockWorkspaceLearningHistory(tx, scope);
  await lockCardForUpdate(tx as Sql, scope.workspaceId, scope.ownerUserId, cardId);
  const card = await loadCard(tx as Sql, scope.workspaceId, cardId);
  if (card.archived || card.autoPaused) throw conflict("这张卡片已暂停，请返回复习列表。");
  if (cardReviewKind(card) !== "question") throw conflict("请先将这张卡片设为题目复习。");
  const state = await loadReviewStateForUpdate(tx as Sql, scope.workspaceId, scope.ownerUserId, cardId);
  const [privateCard] = await tx`SELECT source_ids FROM cards WHERE id=${cardId} AND workspace_id=${scope.workspaceId}`;
  const sourceIds = (privateCard?.source_ids ?? []) as string[];
  await admitLearningSources(tx, scope, sourceIds);
  const sources = sourceIds.length ? await tx`SELECT id,version FROM opening_sources WHERE id=ANY(${sourceIds}::uuid[]) AND workspace_id=${scope.workspaceId}` : [];
  const sourceVersions = Object.fromEntries(sources.map(source => [String(source.id), Number(source.version)]));
  const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  return { card, reps: state?.reps ?? 0, sourceIds, sourceVersions, privacyEpoch: Number(workspace!.privacy_epoch) };
}

async function current(tx: TransactionSql, scope: Scope, cardId: string, activityId: string) {
  const ctx = await cardContext(tx, scope, cardId);
  const [row] = await tx`SELECT * FROM opening_teaching_activities WHERE id=${activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  const intent = row?.create_intent;
  if (!row || intent?.kind !== "card_review_variant" || intent.cardId !== cardId
    || intent.cardContentVersion !== ctx.card.contentVersion || intent.reviewReps !== ctx.reps
    || intent.privacyEpoch !== ctx.privacyEpoch || !isDeepStrictEqual(intent.sourceVersions, ctx.sourceVersions)
    || row.course_id !== ctx.card.courseId) throw conflict("这张卡片或复习进度有更新，请回到复习列表继续。");
  if (["generating", "queued"].includes(String(row.generate_status)) && Date.now() - Date.parse(String(row.created_at)) > 600_000) {
    await tx`UPDATE opening_teaching_activities SET generate_status='unknown',updated_at=now() WHERE id=${activityId}`;
    row.generate_status = "unknown";
  }
  return { ...ctx, row };
}

async function publicReview(tx: TransactionSql, scope: Scope, row: Record<string, unknown>): Promise<CardVariantReview> {
  const activity = mapTeachingActivity(row);
  const clientInit = activity.contentVersion > 0
    ? await createOpeningTeachingContentRepository(proposalTransactionClient(tx)).getClientInit(scope, activity.id) : null;
  return { activity, clientInit };
}

/** Reuses teaching revisions and attempts; only the original card and request metadata are new bindings. */
export function createOpeningCardVariantRepository(sql: Sql) {
  return {
    async classify(scope: Scope, cardId: string, reviewKind: "question" | "concept") {
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockCardForUpdate(tx as Sql, scope.workspaceId, scope.ownerUserId, cardId);
        const card = await loadCard(tx as Sql, scope.workspaceId, cardId);
        if ((card.originObservationRootId || card.tags.includes("错题")) && reviewKind !== "question") throw conflict("错题卡需要用变式复习。");
        await tx`UPDATE cards SET tags=${[...card.tags.filter(tag => !tag.startsWith("review:")), `review:${reviewKind}`]},
          content_version=content_version+1,updated_at=now() WHERE id=${cardId}`;
      });
    },
    async begin(scope: Scope, cardId: string, retry = false) {
      return sql.begin(async tx => {
        const ctx = await cardContext(tx, scope, cardId);
        const binding = createHash("sha256").update(JSON.stringify([ctx.privacyEpoch, Object.entries(ctx.sourceVersions).sort()])).digest("hex").slice(0, 20);
        const baseKey = `card-variant:${cardId}:${ctx.card.contentVersion}:${ctx.reps}:${binding}`;
        let clientKey = baseKey;
        let previousFailedId: string | null = null;
        for (let hops = 0; ; hops++) {
          const [previous] = await tx`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey} FOR UPDATE`;
          if (!previous) {
            // A refresh follows existing retries, but never starts a new paid generation.
            if (previousFailedId && !retry) {
              const result = await current(tx, scope, cardId, previousFailedId);
              return { ...result, fresh: false, review: await publicReview(tx, scope, result.row) };
            }
            break;
          }
          if (previous.generate_status !== "failed") {
            const result = await current(tx, scope, cardId, String(previous.id));
            return { ...result, fresh: false, review: await publicReview(tx, scope, result.row) };
          }
          if (hops >= 20) throw conflict("重试次数较多，请检查模型设置后再继续。");
          previousFailedId = String(previous.id);
          clientKey = `${baseKey}:retry:${String(previous.id)}`;
        }
        const repo = createOpeningTeachingActivitiesRepository(proposalTransactionClient(tx));
        let activity = await repo.create(scope, { clientKey, intentKind: "question", intentSummary: `${ctx.card.skillLabel ?? "知识点"} · 变式复习`,
          sourceIds: ctx.sourceIds, courseId: ctx.card.courseId,
          createIntent: { kind: "card_review_variant", cardId, cardContentVersion: ctx.card.contentVersion, reviewReps: ctx.reps,
            privacyEpoch: ctx.privacyEpoch, sourceVersions: ctx.sourceVersions } });
        if (!activity.courseId) {
          activity = await repo.associateCourse(scope, activity.id, { auto: true });
          await tx`UPDATE cards SET course_id=${activity.courseId},updated_at=now() WHERE id=${cardId}`;
        }
        await tx`UPDATE opening_teaching_activities SET generate_status='generating' WHERE id=${activity.id}`;
        const result = await current(tx, scope, cardId, activity.id);
        return { ...result, fresh: true, review: await publicReview(tx, scope, result.row) };
      });
    },
    async read(scope: Scope, cardId: string, activityId: string) {
      return sql.begin(async tx => publicReview(tx, scope, (await current(tx, scope, cardId, activityId)).row));
    },
    async assertCurrent(scope: Scope, cardId: string, activityId: string) {
      return sql.begin(async tx => {
        const ctx = await current(tx, scope, cardId, activityId);
        if (ctx.row.generate_status !== "generating") throw conflict("变式生成已结束，请查看已有结果。");
      });
    },
    async complete(scope: Scope, cardId: string, activityId: string, raw: unknown) {
      const proposal = cardVariantProposalSchema.parse(raw);
      return sql.begin(async tx => {
        const ctx = await current(tx, scope, cardId, activityId);
        if (ctx.row.generate_status === "ready") return publicReview(tx, scope, ctx.row);
        if (ctx.row.generate_status !== "generating") throw conflict("变式生成已结束。");
        if (checkArithmeticAnswer(proposal.prompt, proposal.referenceAnswer) === "incorrect") {
          throw learningError("VALIDATION", "变式题的参考解答与程序验算不一致，请重新准备题目。");
        }
        const old = await tx`SELECT create_intent->>'variantPrompt' AS prompt FROM opening_teaching_activities
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND create_intent->>'cardId'=${cardId}`;
        if ([ctx.card.front, ...old.map(item => String(item.prompt ?? ""))].some(prompt => questionText(prompt) === questionText(proposal.prompt))) {
          throw learningError("VALIDATION", "生成的题目与原题或之前的复习重复，请重新准备。");
        }
        const content = createOpeningTeachingContentRepository(proposalTransactionClient(tx));
        const blocks = [
          { id: randomUUID(), type: "prompt", content: { text: proposal.prompt, skillLabel: ctx.card.skillLabel ?? "题目复习", estimatedMinutes: proposal.estimatedMinutes } },
          { id: randomUUID(), type: "answer_key", content: { hidden: true, generated: true, hints: proposal.hints,
            answer: proposal.referenceAnswer, rubric: proposal.rubric } },
        ];
        const unit = await content.createUnit(scope, { title: "变式复习", blocks, verificationStatus: "needs_check" });
        await content.publishActivitySpec(scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0,
          expectedRevisionNumber: unit.currentRevisionNumber, revisionNumber: unit.currentRevisionNumber,
          blockOrder: blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, role: block.type as "prompt" | "answer_key", position })),
          sourceRefs: Object.entries(ctx.sourceVersions).map(([sourceId, version]) => ({ sourceId, version })), verificationStatus: "needs_check" });
        const [revision] = await tx`SELECT id FROM library_revisions WHERE document_id=${unit.documentId} AND revision_number=${unit.currentRevisionNumber} AND workspace_id=${scope.workspaceId}`;
        const [saved] = await tx`UPDATE opening_teaching_activities SET generate_status='ready',
          create_intent=create_intent || ${tx.json({ variantPrompt: proposal.prompt, estimatedMinutes: proposal.estimatedMinutes, variantBlockId: blocks[0]!.id, variantRevisionId: String(revision!.id), variantContentVersion: 1 })},updated_at=now()
          WHERE id=${activityId} RETURNING *`;
        return publicReview(tx, scope, saved!);
      });
    },
    async fail(scope: Scope, cardId: string, activityId: string, status: "failed" | "unknown") {
      return sql.begin(async tx => {
        const ctx = await current(tx, scope, cardId, activityId);
        if (ctx.row.generate_status === "generating") await tx`UPDATE opening_teaching_activities SET generate_status=${status},updated_at=now() WHERE id=${activityId}`;
      });
    },
  };
}
