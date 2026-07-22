/**
 * Pure domain package — no UI/DB/Redis imports.
 * Workspace smoke symbol used by monorepo quality gates.
 */
export const PLATFORM_NAME = "AIstudy";
export function isSummaryBand(value) {
    return (value === "stable" ||
        value === "usable" ||
        value === "weak" ||
        value === "untested");
}
//# sourceMappingURL=index.js.map