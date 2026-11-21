import { portableAnkiDeckSchema, type PortableAnkiDeck } from "@aistudy/contracts/learner-portability";

const columns = "#columns:GUID\tFront\tBack\tSource\tTags";
const escapingHeader = "# AIstudy text escaping v1";
const escapePrefix = "~aistudy~";
const formulaStart = /^[\s\p{Cc}\p{Cf}]*[=+@＝＋－＠-]/u;

function encodeText(value: string, header = false): string {
  return value.startsWith(escapePrefix) || formulaStart.test(value) || (header && value.includes("\t"))
    ? escapePrefix + JSON.stringify(value) : value;
}

function decodeText(value: string, escaped: boolean): string {
  if (!escaped || !value.startsWith(escapePrefix)) return value;
  const decoded: unknown = JSON.parse(value.slice(escapePrefix.length));
  if (typeof decoded !== "string") throw new TypeError("Invalid Anki TSV text escape");
  return decoded;
}

function quote(value: string): string {
  return /[\t\r\n"]/.test(value) || value.startsWith("#") ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Anki text import with a GUID, source field and tags column. */
export function exportAnkiTsv(input: PortableAnkiDeck): string {
  const { name, cards } = portableAnkiDeckSchema.parse(input);
  const header = ["#separator:Tab", "#html:false", `#deck:${encodeText(name, true)}`, "#guid column:1", "#tags column:5", escapingHeader, columns];
  const rows = cards.map(card => [card.id, card.front, card.back, card.source, card.tags.join(" ")]
    .map(value => quote(encodeText(value))).join("\t"));
  return [...header, ...rows].join("\n");
}

function tsvRows(text: string): string[][] {
  const rows: string[][] = [];
  if (!text) return rows;
  let row: string[] = [];
  let offset = 0;
  while (offset <= text.length) {
    let field = "";
    if (text[offset] === '"') {
      offset++;
      for (;;) {
        const quoteAt = text.indexOf('"', offset);
        if (quoteAt === -1) throw new TypeError("Unterminated Anki TSV field");
        field += text.slice(offset, quoteAt);
        offset = quoteAt + 1;
        if (text[offset] !== '"') break;
        field += '"';
        offset++;
      }
    } else {
      const start = offset;
      while (offset < text.length && !/[\t\r\n"]/u.test(text[offset]!)) offset++;
      field = text.slice(start, offset);
    }
    row.push(field);
    if (text[offset] === "\t") {
      offset++;
      continue;
    }
    if (offset === text.length) {
      rows.push(row);
      break;
    }
    if (text[offset] === "\r" && text[offset + 1] === "\n") offset++;
    if (text[offset] !== "\n") throw new TypeError("Invalid Anki TSV delimiter");
    rows.push(row);
    row = [];
    if (++offset === text.length) break;
  }
  return rows;
}

/** Reads the SDK's Anki-compatible TSV field mapping. */
export function importAnkiTsv(tsv: string): PortableAnkiDeck {
  const header = /^\uFEFF?#separator:Tab\r?\n#html:false\r?\n#deck:([^\r\n]+)\r?\n#guid column:1\r?\n#tags column:5\r?\n/u.exec(tsv);
  if (!header) throw new TypeError("Anki TSV field mapping is missing");
  let afterHeader = tsv.slice(header[0].length);
  const escaped = afterHeader.split(/\r?\n/u, 1)[0] === escapingHeader;
  if (escaped) afterHeader = afterHeader.slice(escapingHeader.length).replace(/^\r?\n/u, "");
  if (afterHeader.split(/\r?\n/u, 1)[0] !== columns) throw new TypeError("Anki TSV columns do not match the field mapping");
  const body = afterHeader.slice(columns.length).replace(/^\r?\n/u, "");
  const cards = tsvRows(body).map(row => {
    if (row.length !== 5) throw new TypeError("Expected five Anki TSV fields");
    const [id, front, back, source, tags] = row.map(value => decodeText(value, escaped));
    return { id, front, back, source, tags: tags ? tags.split(" ") : [] };
  });
  return portableAnkiDeckSchema.parse({ name: decodeText(header[1]!, escaped), cards });
}
