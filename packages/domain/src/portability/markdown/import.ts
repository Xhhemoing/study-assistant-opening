import type { BlockIdentity } from "@aistudy/contracts";
import { emptyLossReport } from "./loss";
import { parseFrontmatter } from "./frontmatter";
import { parseBlocks } from "./parse";
import type { PortableDocument } from "./types";

export type MarkdownImportResult = {
  document: PortableDocument;
  identityMap: BlockIdentity[];
  lossReport: ReturnType<typeof emptyLossReport>;
};

export function importMarkdown(markdown: string): MarkdownImportResult {
  const { meta, body } = parseFrontmatter(markdown);
  const chunks = parseBlocks(body, meta.id);
  return {
    document: {
      id: meta.id,
      title: meta.title,
      tags: meta.tags,
      sourceFiles: meta.sourceFiles,
      blocks: chunks.map((chunk) => chunk.block),
    },
    identityMap: chunks.map((chunk) => chunk.identity),
    lossReport: emptyLossReport(chunks.flatMap((chunk) => chunk.losses)),
  };
}
