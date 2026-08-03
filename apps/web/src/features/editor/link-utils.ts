const WIKI_LINK_PATTERN = /\[\[([^\]\n]+)\]\]/g;

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join(" ");
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.text === "string") parts.push(record.text);
  for (const [key, child] of Object.entries(record)) {
    if (key !== "text" && key !== "id" && key !== "type") parts.push(collectText(child));
  }
  return parts.join(" ");
}

export function extractWikiLinks(blocks: unknown[]): string[] {
  const found = new Set<string>();
  for (const block of blocks) {
    const text = collectText(block);
    for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
      const title = match[1]?.trim();
      if (title) found.add(title);
    }
  }
  return [...found];
}
