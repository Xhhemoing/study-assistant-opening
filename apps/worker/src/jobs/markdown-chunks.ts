const MARKDOWN_CHUNK = 4_000;

/** Split Markdown into text chunks. HTML is left as text and never executed. */
export function markdownChunks(text: string): Array<{ page: number; text: string }> {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > MARKDOWN_CHUNK && current) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => ({ page: index + 1, text: chunk }));
}
