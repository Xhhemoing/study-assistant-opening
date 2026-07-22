/**
 * Pure domain package — no UI/DB/Redis imports.
 * Workspace smoke symbol used by monorepo quality gates.
 */
export declare const PLATFORM_NAME: "AIstudy";
export type SummaryBand = "stable" | "usable" | "weak" | "untested";
export declare function isSummaryBand(value: string): value is SummaryBand;
//# sourceMappingURL=index.d.ts.map