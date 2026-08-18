import type { AttachmentManifestEntry } from "@aistudy/contracts";

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

export function mediaFromCardText(cardId: string, ...parts: string[]): AttachmentManifestEntry[] {
  const found: AttachmentManifestEntry[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(IMAGE_RE)) {
      const href = match[2] ?? "";
      if (!href || seen.has(href)) continue;
      seen.add(href);
      found.push({
        id: found.length === 0 ? cardId : `${cardId}-${found.length}`,
        filename: href.split("/").at(-1) || "attachment",
        mediaType: "application/octet-stream",
        href,
      });
    }
  }
  return found;
}
