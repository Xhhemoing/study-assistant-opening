const MARKUP_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<!DOCTYPE\s+(?:"[^"]*"|'[^']*'|\[[^\]]*\]|[^"'[>])*>|<(\/?)([\p{L}_:][\p{L}\p{M}\p{N}_.:-]*)(?:(?:\s+|(?<=["']))[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>="'`]+))?)*\s*\/?>/giu;

const NON_PROSE_ELEMENTS = new Set([
  "audio", "button", "canvas", "details", "dialog", "fieldset", "form", "iframe", "noscript", "object",
  "optgroup", "option", "select", "template", "video",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

/** Masks markup with spaces, preserving UTF-16 offsets for citations into the original text. */
export function maskIeltsMarkup(text: string): string {
  const tokens = new RegExp(MARKUP_TOKEN);
  const containers: string[] = [];
  let output = "";
  let end = 0;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const [, closing, tag] = token;
    const name = tag?.toLowerCase();
    output += containers.length ? " ".repeat(token.index - end) : text.slice(end, token.index);
    if (name && !closing && RAW_TEXT_ELEMENTS.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, "giu");
      close.lastIndex = tokens.lastIndex;
      tokens.lastIndex = close.exec(text) ? close.lastIndex : text.length;
    } else if (name && NON_PROSE_ELEMENTS.has(name)) {
      if (closing) {
        const opener = containers.lastIndexOf(name);
        if (opener !== -1) containers.length = opener;
      } else {
        containers.push(name);
      }
    }
    end = tokens.lastIndex;
    output += " ".repeat(end - token.index);
  }
  return output + (containers.length ? " ".repeat(text.length - end) : text.slice(end));
}

export function maskIeltsParagraphs(paragraphs: readonly string[]): string[] {
  // A comment, attribute, or raw-text element may span multiple essay paragraphs.
  const prose = maskIeltsMarkup(paragraphs.join("\n"));
  let start = 0;
  return paragraphs.map((paragraph) => {
    const end = start + paragraph.length;
    const masked = prose.slice(start, end);
    start = end + 1;
    return masked;
  });
}

export function countProseWords(prose: string): number {
  const tokens = prose.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return tokens?.filter((token) => /[A-Za-z]/u.test(token)).length ?? 0;
}
