import type { LossEntry } from "@aistudy/contracts";
import { wikiTransclusionLoss } from "./loss";
import type { PortableBlock, PortableLink } from "./types";
import { blockMarker } from "./types";

const BLOCK_RE = /<!--\s*aistudy-block:([^\s>]+)\s*-->/g;
const WIKI_RE = /!\[\[[^\]]+\]\]/;

export type ParsedBlockChunk = {
  block: PortableBlock;
  losses: LossEntry[];
  identity: { blockId: string; marker: string };
};

export function parseBlocks(body: string, documentId: string): ParsedBlockChunk[] {
  const chunks: ParsedBlockChunk[] = [];
  const matches = [...body.matchAll(BLOCK_RE)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;
    const blockId = match[1] ?? `imported-block-${index + 1}`;
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    const content = body.slice(start, end).trim();
    chunks.push(parseChunk(blockId, content, documentId));
  }
  return chunks;
}

function parseChunk(blockId: string, content: string, documentId: string): ParsedBlockChunk {
  const identity = { blockId, marker: blockMarker(blockId) };
  const unsupported = content.match(/^<!--\s*aistudy-unsupported:([^\s>]+)\s*-->/);
  if (unsupported) {
    const feature = unsupported[1] ?? "unknown";
    return {
      identity,
      losses: [{
        code: "unsupported-block",
        feature,
        message: "Unsupported Markdown feature was preserved only as a marker.",
        blockId,
        documentId,
      }],
      block: { id: blockId, kind: "unsupported", feature, detail: "" },
    };
  }
  if (content.startsWith("```")) return { identity, losses: [], block: parseCode(blockId, content) };
  if (content.startsWith("$$")) {
    const math = content.replace(/^\$\$\s*/, "").replace(/\s*\$\$$/, "");
    return { identity, losses: [], block: { id: blockId, kind: "math", text: math.trim() } };
  }
  if (content.startsWith("|")) return { identity, losses: [], block: parseTable(blockId, content) };
  if (content.startsWith("![")) return { identity, losses: [], block: parseAttachment(blockId, content) };
  const heading = content.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = Math.min(heading[1]?.length ?? 1, 6) as 1 | 2 | 3 | 4 | 5 | 6;
    return { identity, losses: [], block: { id: blockId, kind: "heading", level, text: heading[2] ?? "" } };
  }
  const ordered = content.match(/^\d+\.\s+(.*)$/);
  if (ordered) {
    return { identity, losses: [], block: { id: blockId, kind: "list-item", ordered: true, text: ordered[1] ?? "" } };
  }
  const bullet = content.match(/^[-*]\s+(.*)$/);
  if (bullet) {
    return { identity, losses: [], block: { id: blockId, kind: "list-item", ordered: false, text: bullet[1] ?? "" } };
  }
  return parseParagraph(blockId, content, documentId, identity);
}

function parseParagraph(
  blockId: string,
  content: string,
  documentId: string,
  identity: ParsedBlockChunk["identity"],
): ParsedBlockChunk {
  const { text, links } = extractLinks(content);
  const losses: LossEntry[] = [];
  if (WIKI_RE.test(text) || WIKI_RE.test(content)) {
    losses.push(wikiTransclusionLoss(documentId, blockId));
  }
  return { identity, losses, block: { id: blockId, kind: "paragraph", text, links } };
}

function extractLinks(markdown: string): { text: string; links: PortableLink[] } {
  const links: PortableLink[] = [];
  const text = markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    links.push({ label, href });
    return label;
  });
  return { text, links };
}

function parseCode(blockId: string, content: string): PortableBlock {
  const match = content.match(/^```([^\n]*)\n([\s\S]*?)\n```$/);
  return {
    id: blockId,
    kind: "code",
    language: (match?.[1] ?? "").trim(),
    text: match?.[2] ?? content.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, ""),
  };
}

function parseTable(blockId: string, content: string): PortableBlock {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const headers = cells(lines[0] ?? "");
  const rows = lines.slice(1).filter((line) => !/^\|[\s:|-]+\|$/.test(line.trim())).map(cells);
  return { id: blockId, kind: "table", headers, rows };
}

function parseAttachment(blockId: string, content: string): PortableBlock {
  const match = content.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
  const href = match?.[2] ?? "";
  const filename = href.split("/").at(-1) || "attachment";
  return { id: blockId, kind: "attachment", filename, href, alt: match?.[1] ?? "" };
}
