/**
 * Resolve the effective opening AI daily cap for catalog availability and budget reserve.
 *
 * Safe default: env cap 0 and workspace unset/unconfirmed → disabled (capCents 0).
 * No auto non-zero cap on new installs; owner enables via settings confirm (S2).
 *
 * Matrix (ceiling defaults to OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS):
 * - env > 0, workspace unset → env (source: "env")
 * - env > 0, workspace set → min(env, workspace) (source: "min")
 * - env = 0, unset → 0 (source: "disabled")
 * - env = 0, set + confirmed → min(workspace, ceiling) (source: "workspace")
 * - unconfirmed workspace override → 0 (source: "disabled")
 * - workspace over ceiling → truncated to ceiling
 * - pricingConfigured === false → 0 (source: "disabled")
 */

export const OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS = 2000;

export type EffectiveDailyCapSource = "env" | "workspace" | "min" | "disabled";

export type EffectiveDailyCapInput = {
  envCapCents: number;
  /** Workspace override; null/undefined means unset. */
  workspaceCapCents: number | null | undefined;
  /** Owner confirmed the workspace override (budgetConfirmedAt set). */
  confirmed: boolean;
  /** Personal ceiling applied to workspace overrides; default 2000 cents. */
  ceilingCents?: number;
  /**
   * When false, effective cap is disabled even if env/workspace would allow spend.
   * Default true (caller decides pricing readiness separately when omitted).
   */
  pricingConfigured?: boolean;
};

export type EffectiveDailyCapResult = {
  capCents: number;
  source: EffectiveDailyCapSource;
};

function isSetCap(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveEffectiveDailyCap(input: EffectiveDailyCapInput): EffectiveDailyCapResult {
  if (input.pricingConfigured === false) {
    return { capCents: 0, source: "disabled" };
  }

  const envCapCents = input.envCapCents;
  if (!Number.isSafeInteger(envCapCents) || envCapCents < 0) {
    return { capCents: 0, source: "disabled" };
  }

  const ceilingCents = input.ceilingCents ?? OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS;
  if (!Number.isSafeInteger(ceilingCents) || ceilingCents < 0) {
    return { capCents: 0, source: "disabled" };
  }

  const workspaceCap = isSetCap(input.workspaceCapCents) ? input.workspaceCapCents : null;

  if (envCapCents > 0) {
    if (workspaceCap == null) {
      return { capCents: envCapCents, source: "env" };
    }
    return { capCents: Math.min(envCapCents, workspaceCap), source: "min" };
  }

  // env === 0: workspace override requires confirm; apply personal ceiling.
  if (workspaceCap == null || !input.confirmed) {
    return { capCents: 0, source: "disabled" };
  }

  return {
    capCents: Math.min(workspaceCap, ceilingCents),
    source: "workspace",
  };
}
