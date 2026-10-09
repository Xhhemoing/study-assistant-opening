import { OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS, mergeOpeningCatalog, resolveEffectiveDailyCap } from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

export const runtime = "nodejs";

type ReadinessItem = { key: string; ok: boolean; detail: string; fixHint: string };

async function buildItems(sql: Awaited<ReturnType<typeof requireOpeningScope>>["sql"], scope: Awaited<ReturnType<typeof requireOpeningScope>>["scope"]): Promise<ReadinessItem[]> {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  const pricingConfigured = catalog.models.some(m => m.inputCentsPerMillion > 0 && m.outputCentsPerMillion > 0)
    || custom.some(m => m.inputCentsPerMillion > 0 && m.outputCentsPerMillion > 0);
  const effective = resolveEffectiveDailyCap({
    envCapCents: catalog.dailyCapCents,
    workspaceCapCents: preference.settings.dailyCapCents ?? null,
    confirmed: Boolean(preference.settings.budgetConfirmedAt),
    pricingConfigured,
    ceilingCents: OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  });
  const merged = mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId,
    dailyCapCents: effective.capCents,
  });
  const keyed = merged.models.filter(m => m.availability !== "missing_key" && m.availability !== "vault_disabled");
  const available = merged.models.filter(m => m.availability === "available");
  const vision = merged.models.some(m => m.supportsVision && m.availability === "available");

  const timeZone = "Asia/Shanghai";
  const spendRows = await sql`
    SELECT COALESCE(sum(amount_cents), 0)::int AS used
    FROM opening_budget_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND (
        state = 'reserved'
        OR (state = 'completed' AND (created_at AT TIME ZONE ${timeZone})::date = (now() AT TIME ZONE ${timeZone})::date)
      )
  `;
  const usedCents = Number(spendRows[0]?.used ?? 0);
  const remaining = Math.max(0, effective.capCents - usedCents);

  const reconciledRows = await sql`
    SELECT count(*)::int AS n
    FROM opening_budget_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND state = 'completed'
      AND updated_at >= now() - interval '24 hours'
      AND updated_at > created_at + interval '1 minute'
  `;
  const reconciledUnknown = Number(reconciledRows[0]?.n ?? 0);

  let workerOk = true;
  let workerDetail = "worker 积压正常";
  try {
    const backlog = await sql`
      SELECT
        (SELECT count(*)::int FROM opening_outbox WHERE state = 'pending' AND created_at < now() - interval '15 minutes') AS stale_pending,
        (SELECT count(*)::int FROM opening_jobs WHERE state = 'queued' AND created_at < now() - interval '15 minutes') AS stale_queued,
        (SELECT count(*)::int FROM opening_outbox WHERE state = 'failed') AS failed_outbox
    `;
    const stalePending = Number(backlog[0]?.stale_pending ?? 0);
    const staleQueued = Number(backlog[0]?.stale_queued ?? 0);
    const failedOutbox = Number(backlog[0]?.failed_outbox ?? 0);
    workerOk = stalePending === 0 && staleQueued === 0 && failedOutbox === 0;
    workerDetail = workerOk
      ? "worker 积压正常"
      : `有积压：超时 outbox ${stalePending}，超时 queued ${staleQueued}，失败 outbox ${failedOutbox}`;
  } catch {
    workerOk = false;
    workerDetail = "无法读取 worker 积压";
  }

  return [
    {
      key: "provider_key",
      ok: keyed.length > 0,
      detail: keyed.length > 0 ? `${keyed.length} 个模型已配置密钥` : "没有已配置密钥的模型",
      fixHint: "在设置 → AI 模型与供应商中配置密钥，或联系管理员配置服务器目录。",
    },
    {
      key: "default_pricing",
      ok: pricingConfigured,
      detail: pricingConfigured ? "默认模型定价已配置" : "默认模型定价缺失",
      fixHint: "在模型目录或自定义供应商中填写正数单价。",
    },
    {
      key: "daily_budget",
      ok: effective.capCents > 0,
      detail: effective.capCents > 0
        ? `有效日额度 ${effective.capCents} 分，今日已用 ${usedCents}，剩余 ${remaining}`
        : "日额度未开启（有效额度为 0）",
      fixHint: "在设置 → AI 模型与供应商中开启并确认每日额度。",
    },
    {
      key: "reconciled_unknown",
      ok: true,
      detail: `近 24 小时对账完成的未知预留 ${reconciledUnknown} 笔`,
      fixHint: "无需处理；超时未知预留会在下次预留时自动对账。",
    },
    {
      key: "vision_model",
      ok: vision,
      detail: vision ? "有支持图片的可用模型" : "没有支持图片的可用模型",
      fixHint: "在设置中选择 supportsVision 的模型（供照片材料使用）。",
    },
    {
      key: "worker_backlog",
      ok: workerOk,
      detail: workerDetail,
      fixHint: "检查 worker 进程是否在运行，并查看 opening_jobs / opening_outbox。",
    },
    {
      key: "available_model",
      ok: available.length > 0,
      detail: available.length > 0 ? `${available.length} 个模型当前可用` : "当前没有可用模型",
      fixHint: "同时满足密钥、定价与日额度后，模型才会显示为可用。",
    },
  ];
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const items = await buildItems(sql, scope);
    const response = Response.json({ items });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const response = jsonError(mapDomainError(error));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
