import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  buildAiReadinessItems,
  mergeOpeningCatalog,
  resolveBudgetLocalDay,
  resolveBudgetTimeZone,
  resolveEffectiveDailyCap,
} from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import {
  createOpeningAiSettingsRepository,
  createOpeningModelProvidersRepository,
  createOpeningPlanningSettingsRepository,
} from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

export const runtime = "nodejs";

async function buildItems(
  sql: Awaited<ReturnType<typeof requireOpeningScope>>["sql"],
  scope: Awaited<ReturnType<typeof requireOpeningScope>>["scope"],
) {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom, planning] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
    createOpeningPlanningSettingsRepository(sql).get(scope),
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

  // TZ01: same local budget day as ledger reserve (planning TZ → domain bounds).
  const budgetDay = resolveBudgetLocalDay(
    new Date(),
    resolveBudgetTimeZone(planning.settings?.timeZone),
  );
  const spendRows = await sql`
    SELECT COALESCE(sum(amount_cents), 0)::int AS used
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

  return buildAiReadinessItems({
    keyedModelCount: keyed.length,
    pricingConfigured,
    effectiveCapCents: effective.capCents,
    usedCents,
    remainingCents: remaining,
    reconciledUnknownCount: reconciledUnknown,
    visionAvailable: vision,
    workerOk,
    workerDetail,
    availableModelCount: available.length,
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
