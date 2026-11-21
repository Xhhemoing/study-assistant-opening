import {
  isDenseIeltsArray,
  isNonBlankIeltsString,
  type IeltsUpgradeTarget,
  type IeltsWritingDraftSource,
  type IeltsWritingTransferSource,
} from "./types";

export function getWritingDraftSource(draft: IeltsWritingDraftSource): IeltsWritingDraftSource {
  const { draftId, promptId, version, basedOnVersion, assisted, paragraphs } = draft;
  return { draftId, promptId, version, basedOnVersion, assisted, paragraphs: [...paragraphs] };
}

export function getUniqueWritingTargets(targets: readonly IeltsUpgradeTarget[]): IeltsUpgradeTarget[] {
  if (!isDenseIeltsArray(targets, hasValidWritingTargetPatterns)) return [];
  const byId = new Map<string, IeltsUpgradeTarget>();
  for (const target of targets) {
    if (!byId.has(target.id)) byId.set(target.id, target);
  }
  return [...byId.values()];
}

export function hasValidWritingTargetPatterns(value: unknown): value is
  Record<string, unknown> & Pick<IeltsUpgradeTarget, "targetPatterns" | "weakBaselinePatterns" | "clichePatterns"> {
  if (typeof value !== "object" || value === null) return false;
  const { targetPatterns, weakBaselinePatterns, clichePatterns } = value as Record<string, unknown>;
  return isDenseIeltsArray(targetPatterns, isNonBlankIeltsString) &&
    targetPatterns.length > 0 &&
    (weakBaselinePatterns === undefined || isDenseIeltsArray(weakBaselinePatterns, isNonBlankIeltsString)) &&
    (clichePatterns === undefined || isDenseIeltsArray(clichePatterns, isNonBlankIeltsString));
}

export function getWritingTransferSource(
  baseline: IeltsWritingDraftSource,
  targets: readonly IeltsUpgradeTarget[],
  promptStatement?: string,
): IeltsWritingTransferSource {
  const normalizePatterns = (patterns: readonly string[] = []) =>
    patterns.map((pattern) => pattern.trim().replace(/\s+/gu, " "));

  return {
    baseline: getWritingDraftSource(baseline),
    ...(promptStatement?.trim() ? { promptStatement: promptStatement.trim() } : {}),
    targets: getUniqueWritingTargets(targets).map(({ id, category, criterion, label, guidance, targetPatterns, weakBaselinePatterns, clichePatterns }) => ({
      id, category, criterion, label, guidance,
      targetPatterns: normalizePatterns(targetPatterns),
      weakBaselinePatterns: normalizePatterns(weakBaselinePatterns),
      clichePatterns: normalizePatterns(clichePatterns),
    })),
  };
}
