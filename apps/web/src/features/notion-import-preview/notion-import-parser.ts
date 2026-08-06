import {
  extractLinks,
  extractPageBody,
  extractPageTitle,
  extractProperties,
  extractText,
  extractUuid,
  findClosingDiv,
} from "./notion-import-html";
import type {
  ImportAttachment,
  ImportedBlock,
  ImportedLink,
  ImportedPage,
  ImportReport,
  LossKind,
  ZipEntry,
} from "./notion-import-types";

export type {
  ImportAttachment,
  ImportReport,
  ImportedBlock,
  ImportedBlockType,
  ImportedLink,
  ImportedPage,
  ImportedProperty,
  LossKind,
  ZipEntry,
} from "./notion-import-types";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function parseImage(blockHtml: string): ImportedBlock {
  const srcMatch = blockHtml.match(/<img\b[^>]*src="([^"]+)"/iu);
  return { type: "image", text: "", src: srcMatch ? srcMatch[1] : undefined };
}

function parseTable(blockHtml: string): ImportedBlock {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(blockHtml)) !== null) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((cell) =>
      extractText(cell[1] ?? ""),
    );
    rows.push(cells);
  }
  return { type: "table", text: "", rows };
}

function parseColumns(blockHtml: string): ImportedBlock {
  const columns: ImportedBlock[][] = [];
  let cursor = 0;
  while (cursor < blockHtml.length) {
    const start = blockHtml.indexOf("notion-column-block", cursor);
    if (start === -1) break;
    const divStart = blockHtml.lastIndexOf("<div", start);
    const end = findClosingDiv(blockHtml, divStart);
    columns.push(extractBlocks(blockHtml.slice(divStart, end)).flat());
    cursor = end;
  }
  if (columns.length === 0) {
    const inner = extractBlocks(blockHtml);
    return { type: "columns", text: "", columns: inner.length ? [inner] : [], losses: ["columns-flattened"] };
  }
  return { type: "columns", text: "", columns };
}

function parseBlock(blockHtml: string): ImportedBlock {
  const lower = blockHtml.toLowerCase();
  if (lower.includes("notion-heading")) {
    const match = blockHtml.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/iu);
    return { type: "heading", text: match ? extractText(match[2] ?? "") : extractText(blockHtml), level: match ? Number(match[1]) : 2 };
  }
  if (lower.includes("notion-bulleted-list")) {
    const items = [...blockHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)].map((item) => extractText(item[1] ?? ""));
    return { type: "bulleted-list", text: "", items };
  }
  if (lower.includes("notion-numbered-list")) {
    const items = [...blockHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)].map((item) => extractText(item[1] ?? ""));
    return { type: "numbered-list", text: "", items };
  }
  if (lower.includes("notion-to-do") || lower.includes("type=\"checkbox\"") || lower.includes("type='checkbox'")) {
    const checked = /<input\b[^>]*type="checkbox"[^>]*checked/iu.test(blockHtml);
    return { type: "to-do", text: extractText(blockHtml), checked };
  }
  if (lower.includes("notion-toggle") || lower.includes("<details")) {
    const summary = blockHtml.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/iu);
    const innerStart = blockHtml.indexOf("<div", 1);
    const children = innerStart === -1 ? [] : extractBlocks(blockHtml.slice(innerStart));
    return {
      type: "toggle",
      text: summary ? extractText(summary[1] ?? "") : extractText(blockHtml),
      children,
      losses: ["toggle-flattened"],
    };
  }
  if (lower.includes("notion-callout") || lower.includes("notion-callout-block")) {
    return { type: "callout", text: extractText(blockHtml), losses: ["callout-style"] };
  }
  if (lower.includes("notion-code") || lower.includes("<pre")) {
    const code = blockHtml.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/iu);
    return { type: "code", text: code ? extractText(code[1] ?? "") : extractText(blockHtml) };
  }
  if (lower.includes("notion-image") || lower.includes("<figure") || lower.includes("<img")) {
    return parseImage(blockHtml);
  }
  if (lower.includes("notion-table") || lower.includes("<table")) {
    return parseTable(blockHtml);
  }
  if (lower.includes("notion-divider") || lower.includes("<hr")) {
    return { type: "divider", text: "" };
  }
  if (lower.includes("notion-column-list")) {
    return parseColumns(blockHtml);
  }
  if (lower.includes("notion-text") || lower.includes("<p")) {
    return { type: "paragraph", text: extractText(blockHtml) };
  }
  return { type: "unknown", text: extractText(blockHtml) };
}

export function extractBlocks(html: string): ImportedBlock[] {
  const blocks: ImportedBlock[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<div", cursor);
    if (start === -1) break;
    const classMatch = html.slice(start, start + 400).match(/class="([^"]*)"/u);
    const className = classMatch?.[1] ?? "";
    const end = findClosingDiv(html, start);
    const blockHtml = html.slice(start, end);
    const isNotionBlock = className.includes("notion-") && className.includes("-block");
    if (isNotionBlock) {
      const block = parseBlock(blockHtml);
      const links = extractLinks(blockHtml);
      if (links.length) block.links = links;
      blocks.push(block);
    } else {
      const innerStart = blockHtml.indexOf("<div", 1);
      const inner = innerStart === -1 ? [] : extractBlocks(blockHtml.slice(innerStart));
      if (inner.length) {
        blocks.push(...inner);
      } else {
        const block = parseBlock(blockHtml);
        const links = extractLinks(blockHtml);
        if (links.length) block.links = links;
        blocks.push(block);
      }
    }
    cursor = end;
  }
  return blocks;
}

export function parseNotionPageHtml(html: string, fileName: string): ImportedPage {
  const id = extractUuid(fileName) ?? extractUuid(html) ?? "missing";
  const body = extractPageBody(html);
  const blocks = extractBlocks(body);
  const attachments = blocks
    .filter((block) => block.type === "image" && block.src && !/^https?:\/\//iu.test(block.src))
    .map((block) => block.src as string);
  const links = blocks.flatMap((block) => block.links ?? []);
  return {
    id,
    title: extractPageTitle(fileName),
    path: fileName,
    blocks,
    properties: extractProperties(html),
    attachments: [...new Set(attachments)],
    links,
  };
}

export function indexNotionZip(entries: ZipEntry[]): {
  pages: ImportedPage[];
  attachments: ImportAttachment[];
  report: ImportReport;
} {
  const pages: ImportedPage[] = [];
  const attachments: ImportAttachment[] = [];
  const pageLinks: { from: string; to: string }[] = [];

  for (const entry of entries) {
    const name = entry.path.split("/").pop() ?? entry.path;
    const lower = name.toLowerCase();
    if (lower === "index.html") continue;
    if (lower.endsWith(".csv")) continue;
    if (lower.endsWith(".html")) {
      const content = typeof entry.content === "string" ? entry.content : new TextDecoder().decode(entry.content);
      const page = parseNotionPageHtml(content, name);
      pages.push(page);
      for (const link of page.links ?? []) {
        pageLinks.push({ from: page.id, to: link.pageId });
      }
      continue;
    }
    if (IMAGE_EXT_RE.test(lower) || lower.endsWith(".pdf") || lower.endsWith(".zip")) {
      const size = typeof entry.content === "string" ? entry.content.length : entry.content.byteLength;
      attachments.push({ path: entry.path, name, size });
    }
  }

  const titleById = new Map(pages.map((page) => [page.id, page.title]));
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const link of block.links ?? []) {
        const target = titleById.get(link.pageId);
        if (target && target !== link.label) link.label = target;
      }
    }
  }

  const lossCounts = new Map<LossKind, number>();
  const pageReports = pages.map((page) => {
    const lossKinds: LossKind[] = [];
    const countLoss = (losses?: LossKind[]) => {
      for (const kind of losses ?? []) {
        lossKinds.push(kind);
        lossCounts.set(kind, (lossCounts.get(kind) ?? 0) + 1);
      }
    };
    for (const block of page.blocks) countLoss(block.losses);
    return {
      id: page.id,
      title: page.title,
      blockCount: page.blocks.length,
      attachmentCount: page.attachments.length,
      lossKinds: [...new Set(lossKinds)],
    };
  });

  const report: ImportReport = {
    pages: pages.length,
    blocks: pages.reduce((sum, page) => sum + page.blocks.length, 0),
    attachments: attachments.length,
    losses: [...lossCounts.entries()].map(([kind, count]) => ({ kind, count })),
    pageReports,
  };

  return { pages, attachments, report };
}
