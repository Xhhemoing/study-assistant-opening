const HTML_CHUNK = 4_000;

/** Visible text only. Scripts, styles, and tags are removed, never executed. */
export function htmlText(value: string): string {
  const withoutHidden = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return withoutHidden.split(/(<pre\b[^>]*>[\s\S]*?<\/pre\s*>)/gi).map(part => {
    const preformatted = /^<pre\b/i.test(part);
    const text = part
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, preformatted ? "" : " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
    // Preformatted content carries code indentation and intentional blank lines.
    // Keep it separate from ordinary whitespace normalization, without sentinels.
    return preformatted ? text : text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }).filter(part => part.trim()).join("\n");
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
