import type { PortableBlock, PortableLink } from "./types";
import { blockMarker } from "./types";

export function serializeBlock(block: PortableBlock): string {
  const marker = `<!-- ${blockMarker(block.id)} -->`;
  return `${marker}\n${serializeBlockBody(block)}`;
}

function serializeBlockBody(block: PortableBlock): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph":
      return injectLinks(block.text, block.links);
    case "list-item":
      return block.ordered ? `1. ${block.text}` : `- ${block.text}`;
    case "code":
      return `\`\`\`${block.language}\n${block.text}\n\`\`\``;
    case "math":
      return `$$\n${block.text}\n$$`;
    case "table":
      return serializeTable(block.headers, block.rows);
    case "attachment":
      return `![${block.alt}](${block.href})`;
    case "unsupported":
      return `<!-- aistudy-unsupported:${block.feature} -->`;
  }
}

function serializeTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  return [line(headers), separator, ...rows.map(line)].join("\n");
}

function injectLinks(text: string, links: PortableLink[]): string {
  let next = text;
  for (const link of links) {
    const already = `[${link.label}](${link.href})`;
    if (next.includes(already)) continue;
    const index = next.indexOf(link.label);
    if (index >= 0) {
      next = `${next.slice(0, index)}[${link.label}](${link.href})${next.slice(index + link.label.length)}`;
      continue;
    }
    next = `${next} [${link.label}](${link.href})`.trim();
  }
  return next;
}
