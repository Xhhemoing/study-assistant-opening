/**
 * Pure domain package — no UI/DB/Redis imports.
 * Workspace smoke symbol used by monorepo quality gates.
 */
export const PLATFORM_NAME = "AIstudy" as const;

export type SummaryBand = "stable" | "usable" | "weak" | "untested";

export function isSummaryBand(value: string): value is SummaryBand {
  return (
    value === "stable" ||
    value === "usable" ||
    value === "weak" ||
    value === "untested"
  );
}
