import type { LossReport } from "@aistudy/contracts";

export function buildMarkdownExportRequest(documentId?: string): { documentId?: string } {
  return documentId ? { documentId } : {};
}

export function buildAnkiExportRequest(cardId?: string): { cardId?: string } {
  return cardId ? { cardId } : {};
}

export function markdownExportCopy(lossReport: Pick<LossReport, "claimedLossless" | "losses">): {
  headline: string;
  lossSummary: string;
  disclaimer: string;
} {
  return projectionCopy("Markdown", lossReport);
}

export function ankiExportCopy(lossReport: Pick<LossReport, "claimedLossless" | "losses">): {
  headline: string;
  lossSummary: string;
  disclaimer: string;
} {
  return projectionCopy("Anki", lossReport);
}

function projectionCopy(
  kind: string,
  lossReport: Pick<LossReport, "claimedLossless" | "losses">,
): { headline: string; lossSummary: string; disclaimer: string } {
  const count = lossReport.losses.length;
  return {
    headline: `${kind} 导出`,
    lossSummary: count === 0
      ? `本次没有列出额外损失项，但 ${kind} 仍不是完整备份。`
      : `损失报告列出了 ${count} 项未能写入 ${kind} 的信息。`,
    disclaimer: `${kind} 只是可交换投影，不是完整备份。`,
  };
}
