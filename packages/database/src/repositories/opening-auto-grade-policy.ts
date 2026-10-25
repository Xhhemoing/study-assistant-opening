import type { Sql, TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { buildAnswerGradingInput, reservationTerms, mediaInputCostBound, resolveBudgetLocalDay, resolveBudgetTimeZone, type ResolvedTaskModel } from "@aistudy/ai";
import { checkOpeningBudgetAvailable, type OpeningBudgetAvailability, type OpeningBudgetRepositoryOptions } from "./opening-budget";

export type OpeningAutoGradePolicy = {
  enabled: boolean; modelAvailable: boolean; dailyCap: number;
  modelUnavailableReason?: "budget" | "no_model";
  /** Legacy snapshots are accepted but never authorize admission. */
  dayStart: Date; dayEnd: Date;
  primaryModel?: Omit<ResolvedTaskModel, "provider"> | null;
  fallbackModel?: Omit<ResolvedTaskModel, "provider"> | null;
  budgetOptions?: OpeningBudgetRepositoryOptions;
};

/** Capture after the caller's serialization lock, never from a Web snapshot. */
export async function readOpeningAutoGradeAdmissionTime(sql: Sql | TransactionSql) {
  const [row] = await sql`SELECT clock_timestamp() AS at`;
  return new Date(row!.at);
}

/** Caller serializes workspace learning writes before counting and inserting. */
export async function readOpeningAutoGradeSkip(sql: Sql | TransactionSql, scope: Scope, policy: OpeningAutoGradePolicy,
  admissionAt?: Date) {
  if (!policy.enabled) return "disabled" as const;
  const [preferences] = await sql`SELECT auto_grade_on_save,planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  if (preferences?.auto_grade_on_save === false) return "disabled" as const;
  if (!policy.modelAvailable) return policy.modelUnavailableReason ?? "no_model";
  const day = resolveBudgetLocalDay(admissionAt ?? await readOpeningAutoGradeAdmissionTime(sql),
    resolveBudgetTimeZone(preferences?.planning_settings?.timeZone));
  const [row] = await sql`SELECT count(*)::int AS n FROM opening_learning_observations
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND auto_grade_enqueued_at>=${day.dayStart} AND auto_grade_enqueued_at<${day.nextDayStart}`;
  return Number(row?.n ?? 0) >= policy.dailyCap ? "daily_cap" as const : null;
}

export type OpeningAutoGradeBudgetContext = {
  question: string; answer: string; referenceText: string;
  misconceptions?: Parameters<typeof buildAnswerGradingInput>[0]["misconceptions"];
  workSource?: { mime?: string; bytes?: number } | null;
};

/** Metadata-only estimate: no fabricated image payload or provider invocation.
 * reservationTerms strips encoded bytes before pricing. PDF source size cannot
 * establish the rendered page size, so PDF admission remains indeterminate. */
export async function checkOpeningAutoGradeBudget(tx: Sql | TransactionSql, scope: Scope, policy: OpeningAutoGradePolicy, context: OpeningAutoGradeBudgetContext): Promise<OpeningBudgetAvailability | { allowed: false; reason: "budget_unavailable" }> {
  const check = async (model: Omit<ResolvedTaskModel, "provider"> | null | undefined) => {
    if (!model) return { allowed: false, reason: "budget_unavailable" } as const;
    const imageParts: Parameters<typeof buildAnswerGradingInput>[0]["imageParts"] = [];
    if (context.workSource) {
      const { mime, bytes } = context.workSource;
      const bound = mediaInputCostBound(model.modelSnapshot);
      if (!bound || !Number.isSafeInteger(bytes) || bytes! <= 0 || bytes! > bound.mediaMaxInputBytes
        || (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp")) {
        return { allowed: false, reason: "budget_unavailable" } as const;
      }
      imageParts.push({ data: "", mediaType: mime, sourceId: "sealed", physicalPage: 1 });
    }
    const input = buildAnswerGradingInput({ ...context, imageParts });
    const terms = reservationTerms(model, input, 1);
    // Valid finite prices can still overflow when multiplied by token bounds.
    // This is an unavailable estimate, not a reason to roll back the saved answer.
    if (!Number.isSafeInteger(terms.reservedCents) || terms.reservedCents < 0) {
      return { allowed: false, reason: "budget_unavailable" } as const;
    }
    return checkOpeningBudgetAvailable(tx, scope, { amountCents: terms.reservedCents, modelSnapshot: model.modelSnapshot, requestCapPerDay: terms.requestCapPerDay }, policy.budgetOptions);
  };
  const result = await check(policy.primaryModel);
  if (result.allowed || !policy.fallbackModel) return result;
  // Only deterministic pre-send refusals reach here; SQL/unknown failures throw.
  const fallback = await check(policy.fallbackModel);
  return fallback.allowed ? fallback : result;
}
