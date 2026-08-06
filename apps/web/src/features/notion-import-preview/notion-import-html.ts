import type { ImportedLink, ImportedProperty } from "./notion-import-types";

const NOTION_LINK_RE = /https:\/\/www\.notion\.so\/[^)\s<>"]*?-([0-9a-f]{32})/i;
const UUID_RE = /([0-9a-f]{32})/i;

export function extractUuid(input: string): string | null {
  const match = input.match(UUID_RE);
  return match && match[1] ? match[1].toLowerCase() : null;
}

export function extractPageTitle(fileName: string): string {
  const base = fileName.replace(/\.html$/i, "");
  const uuid = extractUuid(base);
  if (!uuid) return base;
  const title = base.slice(0, base.toLowerCase().lastIndexOf(uuid));
  return title.replace(/[\s_-]+$/u, "").trim() || base;
}

export function findClosingDiv(html: string, start: number): number {
  let depth = 0;
  for (let index = start; index < html.length; index += 1) {
    if (html.startsWith("<div", index)) depth += 1;
    if (html.startsWith("</div>", index)) {
      depth -= 1;
      if (depth === 0) return index + 6;
    }
  }
  return html.length;
}

export function extractPageBody(html: string): string {
  const marker = html.indexOf("page-body");
  if (marker === -1) return html;
  const divStart = html.lastIndexOf("<div", marker);
  if (divStart === -1) return html;
  return html.slice(divStart, findClosingDiv(html, divStart));
}

export function extractText(html: string): string {
  return html
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractLinks(html: string): ImportedLink[] {
  const links: ImportedLink[] = [];
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1] ?? "";
    const notionMatch = href.match(NOTION_LINK_RE);
    if (notionMatch && notionMatch[1]) {
      links.push({ pageId: notionMatch[1].toLowerCase(), label: extractText(match[2] ?? "") });
    }
  }
  return links;
}

export function extractProperties(html: string): ImportedProperty[] {
  const bodyStart = html.indexOf("page-body");
  const head = bodyStart === -1 ? html : html.slice(0, bodyStart);
  const properties: ImportedProperty[] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/giu;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(head)) !== null) {
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(tableMatch[1] ?? "")) !== null) {
      const cells = [...(rowMatch[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((cell) =>
        extractText(cell[1] ?? ""),
      );
      if (cells.length >= 2 && cells[0] && cells[1] !== undefined) {
        properties.push({ name: cells[0], type: "text", value: cells[1] });
      }
    }
  }
  return properties;
}
