const MARKDOWN_CHUNK = 4_000;
const MAX_MARKDOWN_CHUNK_LENGTH = 100_000;

function safeUtf16SliceEnd(text: string, maxEnd: number): number {
  if (maxEnd >= text.length) return text.length;
  const prev = text.charCodeAt(maxEnd - 1);
  const next = text.charCodeAt(maxEnd);
  if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return maxEnd - 1;
  }
  return maxEnd;
}

function splitOversizedChunk(text: string): string[] {
  if (text.length <= MAX_MARKDOWN_CHUNK_LENGTH) return [text];
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= MAX_MARKDOWN_CHUNK_LENGTH) {
      parts.push(text.slice(offset));
      break;
    }
    const maxEnd = safeUtf16SliceEnd(text, offset + MAX_MARKDOWN_CHUNK_LENGTH);
    const newlineIdx = text.lastIndexOf("\n", maxEnd - 1);
    const cut = newlineIdx > offset ? newlineIdx + 1 : maxEnd;
    parts.push(text.slice(offset, cut));
    offset = cut;
  }
  return parts;
}

/** Split Markdown into text chunks. HTML is left as text and never executed. */
export function markdownChunks(text: string): Array<{ page: number; text: string }> {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];
  const blocks = normalized.split(/(\n{2,})/).filter(Boolean);
  const rawChunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current + block;
    if (
      (next.length > MARKDOWN_CHUNK && current.trim() && block.trim())
      || (next.length > MAX_MARKDOWN_CHUNK_LENGTH && current.length > 0)
    ) {
      rawChunks.push(...splitOversizedChunk(current));
      current = block;
    } else {
      current = next;
    }
  }
  if (current) rawChunks.push(...splitOversizedChunk(current));
  return rawChunks.map((chunk, index) => ({ page: index + 1, text: chunk }));
}
