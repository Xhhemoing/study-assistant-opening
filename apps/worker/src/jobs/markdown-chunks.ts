const MARKDOWN_CHUNK = 4_000;

/** Split Markdown into text chunks. HTML is left as text and never executed. */
export function markdownChunks(text: string): Array<{ page: number; text: string }> {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];
  const blocks = normalized.split(/(\n{2,})/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current + block;
    if (next.length > MARKDOWN_CHUNK && current.trim() && block.trim()) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => ({ page: index + 1, text: chunk }));
}
