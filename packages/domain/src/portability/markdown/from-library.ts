import type { PortableBlock, PortableDocument, PortableSourceFile } from "./types";

export type LibraryBlockLike = {
  id: string;
  type: string;
  content: Record<string, unknown>;
};

export type LibraryDocumentLike = {
  id: string;
  title: string;
  tags: string[];
  blocks: LibraryBlockLike[];
  sourceFiles?: PortableSourceFile[];
};

export function libraryDocumentToPortable(input: LibraryDocumentLike): PortableDocument {
  return {
    id: input.id,
    title: input.title,
    tags: input.tags,
    sourceFiles: input.sourceFiles ?? [],
    blocks: input.blocks.map(mapBlock),
  };
}

function mapBlock(block: LibraryBlockLike): PortableBlock {
  const text = extractText(block.content);
  const props = record(block.content.props);
  switch (block.type) {
    case "heading":
      return { id: block.id, kind: "heading", level: headingLevel(block.content, props), text };
    case "paragraph": {
      const { text: plain, links } = extractLinks(text);
      return { id: block.id, kind: "paragraph", text: plain, links };
    }
    case "bulletListItem":
    case "bullet":
    case "list-item":
      return { id: block.id, kind: "list-item", ordered: false, text };
    case "numberedListItem":
    case "numbered":
      return { id: block.id, kind: "list-item", ordered: true, text };
    case "codeBlock":
    case "code":
      return {
        id: block.id,
        kind: "code",
        language: stringField(block.content, "language") || stringField(props, "language"),
        text,
      };
    case "math":
    case "equation":
      return { id: block.id, kind: "math", text };
    case "table":
      return mapTable(block, text);
    case "image":
    case "file":
    case "attachment":
      return mapAttachment(block, text);
    default:
      return { id: block.id, kind: "unsupported", feature: block.type, detail: text };
  }
}

function mapTable(block: LibraryBlockLike, text: string): PortableBlock {
  const headers = stringArray(block.content.headers);
  const rows = Array.isArray(block.content.rows)
    ? block.content.rows.map((row) => stringArray(row))
    : [];
  if (headers.length === 0) {
    return { id: block.id, kind: "unsupported", feature: "table", detail: text };
  }
  return { id: block.id, kind: "table", headers, rows };
}

function mapAttachment(block: LibraryBlockLike, text: string): PortableBlock {
  const href = stringField(block.content, "href") || stringField(block.content, "url") || text;
  const filename = stringField(block.content, "filename") || href.split("/").at(-1) || "attachment";
  return {
    id: block.id,
    kind: "attachment",
    filename,
    href,
    alt: stringField(block.content, "alt") || text,
    mediaType: stringField(block.content, "mediaType") || undefined,
  };
}

function headingLevel(
  content: Record<string, unknown>,
  props: Record<string, unknown>,
): 1 | 2 | 3 | 4 | 5 | 6 {
  const raw = Number(content.level ?? props.level ?? 1);
  if (raw >= 1 && raw <= 6) return raw as 1 | 2 | 3 | 4 | 5 | 6;
  return 1;
}

function extractLinks(markdown: string): { text: string; links: Array<{ label: string; href: string }> } {
  const links: Array<{ label: string; href: string }> = [];
  const text = markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    links.push({ label, href });
    return label;
  });
  return { text, links };
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return `${value.text}${extractText(value.content)}`;
  if ("blockNoteContent" in value) return extractText(value.blockNoteContent);
  if ("content" in value) return extractText(value.content);
  return "";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
