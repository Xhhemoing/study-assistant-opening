import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  buildAiReadinessItems,
  mergeOpeningCatalog,
  resolveBudgetLocalDay,
  resolveBudgetTimeZone,
  resolveEffectiveDailyCap,
} from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readAiReadinessInputs } from "../../../../features/opening/server/data-services";
import { readParserHealth } from "../../../../features/opening/server/parser-health-service";
import { parserOcrReadinessItem } from "../../../../features/opening/assistant/ai-readiness-model";

export const runtime = "nodejs";

async function buildItems(
  sql: Awaited<ReturnType<typeof requireOpeningScope>>["sql"],
  scope: Awaited<ReturnType<typeof requireOpeningScope>>["scope"],
) {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom, planning] = await readAiReadinessInputs(sql, scope);
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
    dailyCapCents: effective.capCents, dailyQuotaMode: catalog.dailyQuotaMode,
  });
  const keyed = merged.models.filter(m => m.availability !== "missing_key" && m.availability !== "vault_disabled");
  const available = merged.models.filter(m => m.availability === "available");
  const freeAvailable = available.some(m => m.billing === "free_tier");
  const vision = merged.models.some(m => m.supportsVision && m.availability === "available");

  // TZ01: same local budget day as ledger reserve (planning TZ → domain bounds).
  const budgetDay = resolveBudgetLocalDay(
    new Date(),
    resolveBudgetTimeZone(planning.settings?.timeZone),
  );
  const spendRows = await sql`
    SELECT COALESCE(sum(amount_cents), 0) AS used
    FROM opening_budget_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND (
        state = 'reserved'
        OR (state = 'completed' AND created_at >= ${budgetDay.dayStart}
          AND created_at < ${budgetDay.nextDayStart})
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
  let workerUnknown = false;
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
    workerUnknown = true;
    workerDetail = "无法读取 worker 积压";
  }

  let parserReport: Awaited<ReturnType<typeof readParserHealth>> = null;
  try { parserReport = await readParserHealth(sql); }
  catch { /* Older schema/unavailable health storage is unknown, never ready. */ }
  const ocrItem = parserOcrReadinessItem(parserReport);

  return buildAiReadinessItems({
    keyedModelCount: keyed.length,
    // Free models satisfy readiness, but must not authorize a paid cap above.
    pricingConfigured: pricingConfigured || freeAvailable,
    effectiveCapCents: effective.capCents, dailyQuotaMode: catalog.dailyQuotaMode,
    usedCents,
    remainingCents: remaining,
    reconciledUnknownCount: reconciledUnknown,
    visionAvailable: vision,
    parserOcrReady: ocrItem.ok,
    workerOk,
    workerDetail,
    availableModelCount: available.length,
  }).map(item => {
    if (item.key === "parser_ocr") return ocrItem;
    if (item.key === "worker_backlog" && workerUnknown) return { ...item, status: "unknown" as const };
    if (item.key === "default_pricing" && freeAvailable && !pricingConfigured) return {
      ...item, detail: "免费额度模型可用，无需配置按量单价。", fixHint: "免费额度仍受供应商每日请求数限制。",
    };
    if (item.key === "daily_budget" && freeAvailable && catalog.dailyQuotaMode !== "unlimited" && effective.capCents <= 0) return {
      ...item, ok: true, detail: "免费额度模型可用，按供应商每日请求数限制使用；按量计费额度未开启。",
      fixHint: "如需使用按量计费模型，请在高级设置开启并确认每日额度。",
    };
    return item;
  });
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
