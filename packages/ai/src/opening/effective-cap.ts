/** Built-in personal ceiling when env cap is 0 and the owner confirms a workspace cap (cents). */
export const OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS = 2000;

export type ResolveEffectiveDailyCapInput = {
  envCapCents: number;
  workspaceCapCents: number | null | undefined;
  confirmed: boolean;
  /** When env is 0 and a workspace cap is confirmed, pricing must already be configured. */
  pricingConfigured?: boolean;
  ceilingCents?: number;
};

export type EffectiveDailyCap = {
  capCents: number;
  source: "env" | "workspace" | "min" | "disabled";
};

/**
 * Resolve the effective daily AI budget for a workspace.
 * Env > 0 and no workspace value → env; env > 0 and workspace set → min(env, workspace);
 * env = 0 and unset/unconfirmed → 0; env = 0 with confirmed workspace → min(workspace, ceiling).
 */
export function resolveEffectiveDailyCap(input: ResolveEffectiveDailyCapInput): EffectiveDailyCap {
  if (!Number.isSafeInteger(input.envCapCents) || input.envCapCents < 0) {
    throw new Error("invalid env daily cap");
  }
  const ceiling = input.ceilingCents ?? OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new Error("invalid personal daily cap ceiling");
  }
  const workspace = input.workspaceCapCents;
  if (workspace != null && (!Number.isSafeInteger(workspace) || workspace < 0)) {
    throw new Error("invalid workspace daily cap");
  }

  if (input.envCapCents > 0) {
    if (workspace == null) return { capCents: input.envCapCents, source: "env" };
    return { capCents: Math.min(input.envCapCents, workspace), source: "min" };
  }

  if (workspace == null || !input.confirmed) {
    return { capCents: 0, source: "disabled" };
  }
  if (input.pricingConfigured === false) {
    return { capCents: 0, source: "disabled" };
  }
  return { capCents: Math.min(workspace, ceiling), source: "workspace" };
}
