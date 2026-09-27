const HTML_CHUNK = 4_000;

/** Visible text only. Scripts, styles, and tags are removed, never executed. */
export function htmlText(value: string): string {
  const withoutHidden = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n");
  const text = withBreaks
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text;
}

export function htmlChunks(value: string): Array<{ page: number; text: string }> {
  const text = htmlText(value);
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += HTML_CHUNK) {
    chunks.push(text.slice(index, index + HTML_CHUNK));
  }
  return chunks.map((chunk, index) => ({ page: index + 1, text: chunk }));
}
