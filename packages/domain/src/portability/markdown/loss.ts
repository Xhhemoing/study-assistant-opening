import type { LossEntry, LossReport } from "@aistudy/contracts";

export function emptyLossReport(losses: LossEntry[] = []): LossReport {
  return { claimedLossless: false, losses };
}

export function unsupportedBlockLoss(
  documentId: string,
  blockId: string,
  feature: string,
): LossEntry {
  return {
    code: "unsupported-block",
    feature,
    message: `${capitalize(feature)} blocks are not expressible in Markdown.`,
    blockId,
    documentId,
  };
}

export function wikiTransclusionLoss(documentId: string, blockId?: string): LossEntry {
  return {
    code: "wiki-transclusion",
    feature: "wiki-transclusion",
    message: "Wiki transclusion is not expressible in portable Markdown.",
    ...(blockId ? { blockId } : {}),
    documentId,
  };
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
