import type { IeltsUpgradeTarget, IeltsWritingDraftSource, IeltsWritingTransferSource } from "./types";

export function getWritingDraftSource(draft: IeltsWritingDraftSource): IeltsWritingDraftSource {
  const { draftId, promptId, version, basedOnVersion, assisted, paragraphs } = draft;
  return { draftId, promptId, version, basedOnVersion, assisted, paragraphs: [...paragraphs] };
}

export function getUniqueWritingTargets(targets: readonly IeltsUpgradeTarget[]): IeltsUpgradeTarget[] {
  const byId = new Map<string, IeltsUpgradeTarget>();
  for (const target of targets) {
    if (!byId.has(target.id)) byId.set(target.id, target);
  }
  return [...byId.values()];
}

export function getWritingTransferSource(
  baseline: IeltsWritingDraftSource,
  targets: readonly IeltsUpgradeTarget[],
): IeltsWritingTransferSource {
  const normalizePatterns = (patterns: readonly string[] | undefined) =>
    Array.isArray(patterns)
      ? patterns.map((pattern) => pattern.trim().replace(/\s+/gu, " "))
      : [];

  return {
    baseline: getWritingDraftSource(baseline),
    targets: getUniqueWritingTargets(targets).map(({ id, category, criterion, label, guidance, targetPatterns, weakBaselinePatterns, clichePatterns }) => ({
      id, category, criterion, label, guidance,
      targetPatterns: normalizePatterns(targetPatterns),
      weakBaselinePatterns: normalizePatterns(weakBaselinePatterns),
      clichePatterns: normalizePatterns(clichePatterns),
    })),
  };
}
