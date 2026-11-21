const NON_PROSE_ELEMENTS = new Set([
  "audio", "button", "canvas", "details", "dialog", "fieldset", "form", "math", "object", "svg",
  "optgroup", "option", "select", "template", "video",
]);
const RAW_TEXT_ELEMENTS = new Set([
  "iframe", "noembed", "noframes", "noscript", "script", "style", "textarea", "title", "xmp",
]);

const HTML_SPACE = /[\t\n\f\r ]/u;
const TAG_NAME_CHAR = /[^\t\n\f\r />]/u;
const ATTRIBUTE_NAME_CHAR = /[^\t\n\f\r />=]/u;
const UNQUOTED_VALUE_CHAR = /[^\t\n\f\r >]/u;

function skipSpaces(text: string, cursor: number): number {
  while (HTML_SPACE.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function afterDelimiter(text: string, delimiter: string, start: number): number {
  const index = text.indexOf(delimiter, start);
  return index === -1 ? text.length : index + delimiter.length;
}

/** Reads through a tag's attribute states, including HTML's recovery from a stray slash. */
function readTagEnd(text: string, start: number): { end: number; selfClosing: boolean } {
  let cursor = start;
  while (cursor < text.length) {
    cursor = skipSpaces(text, cursor);
    const character = text[cursor];
    if (character === ">") return { end: cursor + 1, selfClosing: false };
    if (character === "/") {
      if (text[cursor + 1] === ">") return { end: cursor + 2, selfClosing: true };
      cursor += 1;
      continue;
    }
    if (character === undefined) break;

    // An unexpected '=' in the first position is itself part of the attribute name.
    cursor += 1;
    while (ATTRIBUTE_NAME_CHAR.test(text[cursor] ?? "")) cursor += 1;
    cursor = skipSpaces(text, cursor);
    if (text[cursor] !== "=") continue;

    cursor = skipSpaces(text, cursor + 1);
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      cursor = afterDelimiter(text, quote, cursor + 1);
    } else {
      while (UNQUOTED_VALUE_CHAR.test(text[cursor] ?? "")) cursor += 1;
    }
  }
  return { end: text.length, selfClosing: false };
}

function readDeclarationEnd(text: string, start: number): number {
  if (text.startsWith("<!--", start)) {
    const content = start + 4;
    if (text[content] === ">") return content + 1;
    if (text.startsWith("->", content)) return content + 2;
    const closing = /--!?>/gu;
    closing.lastIndex = content;
    return closing.exec(text) ? closing.lastIndex : text.length;
  }
  if (text.startsWith("<![CDATA[", start)) return afterDelimiter(text, "]]>", start + 9);
  if (text[start + 1] === "!" && text.slice(start + 2, start + 9).toLowerCase() === "doctype") {
    let cursor = start + 9;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === ">") return cursor + 1;
      cursor = character === '"' || character === "'" ? afterDelimiter(text, character, cursor + 1) : cursor + 1;
    }
    return text.length;
  }
  // Other declarations and processing instructions are HTML bogus comments.
  return afterDelimiter(text, ">", start + 2);
}

function readRawTextEnd(text: string, name: string, start: number): number {
  if (name !== "script") {
    const closing = new RegExp("</" + name + "(?=[\\t\\n\\f\\r />])", "gi");
    closing.lastIndex = start;
    return closing.exec(text) ? readTagEnd(text, closing.lastIndex).end : text.length;
  }

  const transitions = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  transitions.lastIndex = start;
  let state: "data" | "escaped" | "doubleEscaped" = "data";
  for (let match = transitions.exec(text); match; match = transitions.exec(text)) {
    const token = match[0]!.toLowerCase();
    if (token === "<!--") {
      if (state === "data") state = "escaped";
      // The opening dashes can also start the closing sequence in <!-->.
      transitions.lastIndex -= 2;
    } else if (token === "-->") {
      state = "data";
    } else if (token === "<script") {
      if (state === "escaped") state = "doubleEscaped";
    } else if (state === "doubleEscaped") {
      state = "escaped";
    } else {
      return readTagEnd(text, transitions.lastIndex).end;
    }
  }
  return text.length;
}

/** Masks markup with spaces, preserving UTF-16 offsets for citations into the original text. */
export function maskIeltsMarkup(text: string): string {
  const markupStart = /<(?=[A-Za-z!?]|\/[\s\S])/gu;
  const containers: string[] = [];
  const openCounts = new Map<string, number>();
  const output: string[] = [];
  let end = 0;
  const appendProse = (until: number) => {
    output.push(containers.length ? " ".repeat(until - end) : text.slice(end, until));
  };

  for (let token = markupStart.exec(text); token; token = markupStart.exec(text)) {
    const start = token.index;
    appendProse(start);
    const closing = text[start + 1] === "/";
    const nameStart = start + (closing ? 2 : 1);
    if (!/[A-Za-z]/u.test(text[nameStart] ?? "")) {
      end = readDeclarationEnd(text, start);
    } else {
      let nameEnd = nameStart + 1;
      while (TAG_NAME_CHAR.test(text[nameEnd] ?? "")) nameEnd += 1;
      const name = text.slice(nameStart, nameEnd).toLowerCase();
      const tag = readTagEnd(text, nameEnd);
      end = tag.end;
      const foreignSelfClosing = tag.selfClosing &&
        (name === "svg" || name === "math" || openCounts.has("svg") || openCounts.has("math"));
      if (!closing && !foreignSelfClosing && RAW_TEXT_ELEMENTS.has(name)) {
        end = readRawTextEnd(text, name, end);
      } else if (!closing && !foreignSelfClosing && NON_PROSE_ELEMENTS.has(name)) {
        containers.push(name);
        openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
      } else if (closing && openCounts.has(name)) {
        // Each entry is removed once. Unmatched end tags never scan the open stack.
        let popped: string;
        do {
          popped = containers.pop()!;
          const remaining = openCounts.get(popped)! - 1;
          if (remaining === 0) openCounts.delete(popped);
          else openCounts.set(popped, remaining);
        } while (popped !== name);
      }
    }
    markupStart.lastIndex = end;
    output.push(" ".repeat(end - start));
  }

  appendProse(text.length);
  return output.join("");
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
