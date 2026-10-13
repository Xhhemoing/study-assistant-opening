import type { BlockContent, ListItem, PhrasingContent, Root, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

/** BlockNote block as stored in library_blocks (ids are assigned by the repository). */
export type NoteBlock = {
  type: string;
  props: Record<string, unknown> | null;
  content: unknown;
  children: NoteBlock[];
};

type Styles = { bold?: true; italic?: true; strike?: true; code?: true };
type Inline =
  | { type: "text"; text: string; styles: Styles }
  | { type: "link"; href: string; content: { type: "text"; text: string; styles: Styles }[] };

const SAFE_LINK = /^(https?:|mailto:)/i;
/** Beyond this the note is still saved, just as one paragraph. */
const MAX_BLOCKS = 400;

export type MarkdownBlocksResult = { blocks: NoteBlock[]; structured: boolean };

/**
 * Chat answers are Markdown; notes are BlockNote blocks. Mirrors the chat renderer:
 * raw HTML is dropped, remote images become a text marker, unsafe links lose their href.
 * Anything the parser cannot handle (e.g. pathological nesting) falls back to one paragraph.
 */
export function markdownToNoteBlocks(markdown: string): MarkdownBlocksResult {
  let tree: Root;
  try {
    tree = fromMarkdown(markdown, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
  } catch {
    return plain(markdown);
  }
  const blocks = tree.children.flatMap(toBlocks);
  if (!blocks.length || countBlocks(blocks) > MAX_BLOCKS) return plain(markdown);
  return { blocks, structured: true };
}

function plain(text: string): MarkdownBlocksResult {
  return { blocks: [block("paragraph", null, text)], structured: false };
}

function block(type: string, props: Record<string, unknown> | null, content: unknown, children: NoteBlock[] = []): NoteBlock {
  return { type, props, content, children };
}

function countBlocks(blocks: NoteBlock[]): number {
  return blocks.reduce((sum, item) => sum + 1 + countBlocks(item.children), 0);
}

function toBlocks(node: RootContent | BlockContent): NoteBlock[] {
  switch (node.type) {
    case "heading":
      return [block("heading", { level: node.depth }, inline(node.children))];
    case "paragraph":
      return [block("paragraph", null, inline(node.children))];
    case "list":
      return node.children.map((item) => listItem(item, node.ordered === true));
    case "code":
      return [block("codeBlock", { language: node.lang?.trim() || "text" }, node.value)];
    case "math":
      // Notes have no formula block yet; keep the LaTeX source verbatim.
      return [block("codeBlock", { language: "latex" }, node.value)];
    case "blockquote":
      return [block("quote", null, joinInline(node.children.flatMap(toBlocks)))];
    case "table":
      return [table(node)];
    case "thematicBreak":
      return [block("divider", null, undefined)];
    case "html":
      return [];
    default:
      return [];
  }
}

function listItem(item: ListItem, ordered: boolean): NoteBlock {
  const [first, ...rest] = item.children;
  const type = typeof item.checked === "boolean" ? "checkListItem" : ordered ? "numberedListItem" : "bulletListItem";
  const props = typeof item.checked === "boolean" ? { checked: item.checked } : null;
  const head = first?.type === "paragraph" ? inline(first.children) : [];
  const children = (first?.type === "paragraph" ? rest : item.children).flatMap(toBlocks);
  return block(type, props, head, children);
}

function table(node: Table): NoteBlock {
  const rows = node.children.map((row) => ({ cells: row.children.map((cell) => inline(cell.children)) }));
  const width = Math.max(0, ...rows.map((row) => row.cells.length));
  return block("table", null, {
    type: "tableContent",
    columnWidths: Array.from({ length: width }, () => undefined),
    headerRows: rows.length > 1 ? 1 : undefined,
    rows,
  });
}

/** Quote is a single inline block in BlockNote; nested blocks become lines. */
function joinInline(blocks: NoteBlock[]): Inline[] {
  return merge(blocks.flatMap((item, index) => {
    const content = Array.isArray(item.content) ? item.content as Inline[] : typeof item.content === "string" ? [text(item.content, {})] : [];
    return index ? [text("\n", {}), ...content] : content;
  }));
}

function text(value: string, styles: Styles): { type: "text"; text: string; styles: Styles } {
  return { type: "text", text: value, styles };
}

function inline(nodes: PhrasingContent[], styles: Styles = {}): Inline[] {
  return merge(nodes.flatMap((node): Inline[] => {
    switch (node.type) {
      case "text":
        return [text(node.value, styles)];
      case "strong":
        return inline(node.children, { ...styles, bold: true });
      case "emphasis":
        return inline(node.children, { ...styles, italic: true });
      case "delete":
        return inline(node.children, { ...styles, strike: true });
      case "inlineCode":
        return [text(node.value, { ...styles, code: true })];
      case "inlineMath":
        return [text(`$${node.value}$`, styles)];
      case "break":
        return [text("\n", styles)];
      case "link": {
        const content = inline(node.children, styles).flatMap((part) => part.type === "text" ? [part] : part.content);
        return SAFE_LINK.test(node.url.trim()) ? [{ type: "link", href: node.url, content }] : content;
      }
      case "image":
        return node.alt ? [text(`[图片：${node.alt}]`, styles)] : [];
      case "footnoteReference":
        return [text(`[^${node.label ?? node.identifier}]`, styles)];
      default:
        return [];
    }
  }));
}

/** Adjacent runs with identical styles collapse, so stored content stays compact. */
function merge(parts: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (part.type === "text" && last?.type === "text" && sameStyles(last.styles, part.styles)) {
      out[out.length - 1] = { ...last, text: last.text + part.text };
    } else if (part.type !== "text" || part.text) out.push(part);
  }
  return out;
}

function sameStyles(a: Styles, b: Styles): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code;
}
