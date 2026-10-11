import type { OpeningAiReadinessResponse, Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { loadMergedCatalog, resolveWorkspaceEffectiveCap } from "../../settings/ai-settings-service";

const WORKER_BACKLOG_STALE_MINUTES = 15;

function denylistHit(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "apikey", "api_key", "authorization", "password", "secret", "postgres://",
    "redis://", "bearer ", "sk-", "connection string",
  ].some(token => lower.includes(token));
}

function safeDetail(detail: string): string {
  if (denylistHit(detail)) return "配置异常（详情已隐藏）。请到设置或运维配置检查。";
  return detail.slice(0, 500);
}

export async function buildAiReadiness(sql: Sql, scope: Scope): Promise<OpeningAiReadinessResponse> {
  const [effective, merged] = await Promise.all([
    resolveWorkspaceEffectiveCap(sql, scope),
    loadMergedCatalog(sql, scope),
  ]);

  const modelsWithKey = merged.models.filter(model => model.apiKey.length > 0);
  const keyOk = modelsWithKey.length > 0;
  const defaultModel = merged.models.find(model => model.id === merged.defaultModelId) ?? merged.models[0];
  const pricingOk = Boolean(
    defaultModel
    && defaultModel.inputCentsPerMillion > 0
    && defaultModel.outputCentsPerMillion > 0,
  );
  const budgetOk = effective.capCents > 0;

  const [spendRow] = await sql`
    SELECT COALESCE(sum(amount_cents), 0)::int AS used
    FROM opening_budget_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND (
        state = 'reserved'
        OR (
          state = 'completed'
          AND (created_at AT TIME ZONE 'Asia/Shanghai')::date
            = (now() AT TIME ZONE 'Asia/Shanghai')::date
        )
      )
  `;
  const usedToday = Number(spendRow?.used ?? 0);
  const remaining = Math.max(0, effective.capCents - usedToday);

  const [reconcileRow] = await sql`
    SELECT count(*)::int AS n
    FROM opening_budget_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND state = 'completed'
      AND updated_at >= now() - interval '24 hours'
      AND updated_at - created_at >= interval '30 minutes'
  `;
  const reconciled24h = Number(reconcileRow?.n ?? 0);

  const visionOk = merged.models.some(model => model.supportsVision === true);

  const stale = `${WORKER_BACKLOG_STALE_MINUTES} minutes`;
  const [backlogRow] = await sql`
    SELECT
      (SELECT count(*)::int FROM opening_outbox
        WHERE state = 'pending' AND created_at < now() - ${stale}::interval) AS stale_pending,
      (SELECT count(*)::int FROM opening_outbox WHERE state = 'failed') AS failed_outbox,
      (SELECT count(*)::int FROM opening_jobs
        WHERE state = 'queued' AND kind <> 'remind' AND created_at < now() - ${stale}::interval)
      + (SELECT count(*)::int FROM opening_tutor_jobs
        WHERE status = 'queued' AND created_at < now() - ${stale}::interval) AS stale_queued
  `;
  const backlogOk = Number(backlogRow?.stale_pending ?? 0) === 0
    && Number(backlogRow?.failed_outbox ?? 0) === 0
    && Number(backlogRow?.stale_queued ?? 0) === 0;

  const items = [
    {
      key: "provider_key",
      ok: keyOk,
      detail: keyOk
        ? `已配置 ${modelsWithKey.length} 个带密钥的模型。`
        : "没有可用的模型密钥。请到「设置 → AI」添加工作区模型，或请运维配置服务器 OPENING_MODEL_API_KEY。",
    },
    {
      key: "default_pricing",
      ok: pricingOk,
      detail: pricingOk
        ? "默认模型已配置输入/输出单价。"
        : "默认模型缺少定价。请到设置检查模型价格，或请运维配置 OPENING_MODEL_*_CENTS_PER_MILLION。",
    },
    {
      key: "daily_budget",
      ok: budgetOk,
      detail: budgetOk
        ? `有效日额度 ${effective.capCents} 分（来源 ${effective.source}）；今日已用 ${usedToday} 分，剩余约 ${remaining} 分。`
        : "日预算未启用（安全默认关闭）。请到「设置 → AI」设置并确认工作区日额度（最多 2000 分），或请运维配置 OPENING_MODEL_DAILY_CAP_CENTS。",
    },
    {
      key: "unknown_reconcile_24h",
      ok: true,
      detail: `近 24 小时懒对账完成 ${reconciled24h} 笔超时/未知预留（悲观入账）。`,
    },
    {
      key: "vision_model",
      ok: visionOk,
      detail: visionOk
        ? "目录中至少有一个支持图片的模型（供拍照题目）。"
        : "没有支持图片的模型。拍照题目需要到设置选择支持图片的模型，或请运维在目录中启用。",
    },
    {
      key: "worker_backlog",
      ok: backlogOk,
      detail: backlogOk
        ? "Worker 积压正常。"
        : `Worker 积压异常（stale_pending=${backlogRow?.stale_pending ?? "?"}, failed=${backlogRow?.failed_outbox ?? "?"}, stale_queued=${backlogRow?.stale_queued ?? "?"}）。请检查 worker 进程与 /api/opening/health。`,
    },
  ].map(item => ({ ...item, detail: safeDetail(item.detail) }));

  return { items };
}
