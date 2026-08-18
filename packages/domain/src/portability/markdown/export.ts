import type { AttachmentManifestEntry, LossEntry, PortabilityManifest } from "@aistudy/contracts";
import { emptyLossReport, unsupportedBlockLoss } from "./loss";
import { serializeFrontmatter } from "./frontmatter";
import { serializeBlock } from "./serialize";
import type { PortableDocument } from "./types";
import { blockMarker } from "./types";

export type MarkdownDocumentExport = {
  markdown: string;
  manifest: PortabilityManifest;
  lossReport: ReturnType<typeof emptyLossReport>;
};

export function exportMarkdown(
  document: PortableDocument,
  options: { extraLosses?: LossEntry[] } = {},
): MarkdownDocumentExport {
  const losses: LossEntry[] = [...(options.extraLosses ?? [])];
  const attachments: AttachmentManifestEntry[] = [];
  const blockIdentities = document.blocks.map((block) => {
    if (block.kind === "unsupported") {
      losses.push(unsupportedBlockLoss(document.id, block.id, block.feature));
    }
    if (block.kind === "attachment") {
      attachments.push({
        id: block.id,
        filename: block.filename,
        mediaType: block.mediaType ?? "application/octet-stream",
        href: block.href,
      });
    }
    return { blockId: block.id, marker: blockMarker(block.id) };
  });
  const markdown = [
    serializeFrontmatter(document),
    "",
    document.blocks.map(serializeBlock).join("\n\n"),
    "",
  ].join("\n");
  return {
    markdown,
    manifest: {
      attachments,
      blockIdentities,
      sourceFiles: document.sourceFiles,
    },
    lossReport: emptyLossReport(losses),
  };
}

export function exportMarkdownBundle(documents: PortableDocument[]): MarkdownDocumentExport {
  const parts = documents.map((document) => exportMarkdown(document));
  return {
    markdown: parts.map((part) => part.markdown).join("\n"),
    manifest: {
      attachments: parts.flatMap((part) => part.manifest.attachments),
      blockIdentities: parts.flatMap((part) => part.manifest.blockIdentities),
      sourceFiles: parts.flatMap((part) => part.manifest.sourceFiles),
    },
    lossReport: emptyLossReport(parts.flatMap((part) => part.lossReport.losses)),
  };
}
