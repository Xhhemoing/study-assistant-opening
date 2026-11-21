const leadingMarker = /^---(?=[\s\u0085]|$)/u;
const documentMarker = /^(?:---|\.\.\.)(?=[\s\u0085]|$)/u;
const openingFence = /^---[ \t]*$/u;
const closingFence = /^(?:---|\.\.\.)[ \t]*$/u;
const plainKey = /^[\p{L}_][\p{L}\p{M}\p{N}_.-]*(?: [\p{L}\p{M}\p{N}_.-]+)*$/u;
const scalarKeyword = /^(?:y|n|yes|no|on|off|true|false|null)$/iu;
const privateKeys = new Set([
  "workspaceid", "owneruserid", "userid", "principalid", "sessionid", "tenantid", "accountid", "privacyepoch",
  "claimtoken", "executionid", "jobexecution", "idempotencykey", "clientkey",
  "tutorjobid", "assistantturnid", "userturnid", "conversationid", "sourceturnids", "memorydependencyids",
  "contextsourcerefs", "exposurereceiptid", "materialpurposepin", "sourceversion", "uploadstate", "parsestate", "imageobjectkey",
  "sealed", "solutionsealed", "visibilityhint", "0109", "skillbelief", "skillbeliefv1", "bkt", "fiass", "remedyclinic",
  "examforecast", "diagnosticplacement", "openingcoursereservedquestions", "reservedquestions", "internalrubric", "<<",
]);
const yamlEscapes: Readonly<Record<string, string>> = {
  "0": "\0", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
  " ": " ", "\t": "\t", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029",
};

function invalid(): never {
  throw new TypeError("Unrecognized or private YAML frontmatter");
}

// Walk the data-only YAML grammar without materializing values. Advanced YAML
// constructs such as tags, anchors, aliases and complex keys fail closed.
class FrontmatterReader {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  read(): void {
    this.blankLines();
    if (this.done) return;
    const indent = this.indent();
    const first = this.source[this.offset + indent];
    if (first === "{" || first === "[") {
      this.offset += indent;
      this.flowValue(0);
      this.endLine();
    } else this.block(indent, 0);
    this.blankLines();
    if (!this.done) invalid();
  }

  private get current(): string { return this.source[this.offset] ?? ""; }
  private get done(): boolean { return this.offset >= this.source.length; }

  private skipHorizontal(): void {
    while (this.current === " " || this.current === "\t") this.offset++;
  }

  private indent(): number {
    let end = this.offset;
    while (this.source[end] === " ") end++;
    if (this.source[end] === "\t") invalid();
    return end - this.offset;
  }

  private lineEnd(): number {
    const end = this.source.indexOf("\n", this.offset);
    return end === -1 ? this.source.length : end;
  }

  private blankLines(): void {
    while (!this.done) {
      const start = this.offset;
      this.skipHorizontal();
      if (this.current === "#") this.offset = this.lineEnd();
      if (this.current === "\n") this.offset++;
      else if (!this.done) { this.offset = start; return; }
    }
  }

  private flowTrivia(): void {
    while (!this.done) {
      if (/[ \t\n]/u.test(this.current)) this.offset++;
      else if (this.current === "#") this.offset = this.lineEnd();
      else return;
    }
  }

  private endLine(): void {
    const at = this.offset;
    this.skipHorizontal();
    if (this.current === "#" && this.offset > at) this.offset = this.lineEnd();
    if (this.current === "\n") this.offset++;
    else if (!this.done) invalid();
  }

  private indicator(token: string): boolean {
    const next = this.source[this.offset + 1];
    return this.current === token && (next === undefined || /[ \t\n]/u.test(next));
  }

  private quoted(): string {
    const quote = this.current;
    this.offset++;
    let value = "";
    while (!this.done) {
      const char = this.source[this.offset++]!;
      if (char === quote) {
        if (quote !== "'" || this.current !== "'") return value;
        this.offset++;
      } else if (quote === '"' && char === "\\") {
        const escape = this.source[this.offset++] ?? "";
        const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
        if (width) {
          const hex = this.source.slice(this.offset, this.offset + width);
          if (hex.length !== width || !/^[\da-f]+$/iu.test(hex)) invalid();
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          this.offset += width;
        } else if (Object.hasOwn(yamlEscapes, escape)) value += yamlEscapes[escape];
        else invalid();
        continue;
      } else if (char === "\n") invalid();
      value += char;
    }
    return invalid();
  }

  private plain(flow: boolean): string {
    const start = this.offset;
    if (!this.current || /^[[\]{},#?&*!|>'"%@`:]/u.test(this.current) || this.indicator("-")) invalid();
    while (!this.done) {
      const char = this.current;
      const next = this.source[this.offset + 1] ?? "";
      if (char === "\n" || (char === "#" && /[ \t]/u.test(this.source[this.offset - 1] ?? ""))
        || (flow && /[[\]{},]/u.test(char)) || (char === ":" && (!next || /[ \t\n]/u.test(next) || (flow && /[[\]{},]/u.test(next))))) break;
      this.offset++;
    }
    const value = this.source.slice(start, this.offset).trimEnd();
    if (!value) invalid();
    return value;
  }

  private key(flow: boolean, keys: Set<string>): void {
    const quoted = this.current === '"' || this.current === "'";
    const key = quoted ? this.quoted() : this.plain(flow);
    this.skipHorizontal();
    if (!key || keys.has(key) || (flow ? this.current !== ":" : !this.indicator(":"))
      || (!quoted && (!plainKey.test(key) || scalarKeyword.test(key)))
      || privateKeys.has(key.normalize("NFKC").replace(/[-_.\s]/gu, "").toLowerCase())) invalid();
    keys.add(key);
    this.offset++;
  }

  private flowValue(depth: number): void {
    if (depth > 100) invalid();
    this.flowTrivia();
    const opener = this.source[this.offset];
    if (opener === "[" || opener === "{") {
      const closer = opener === "[" ? "]" : "}";
      const keys = new Set<string>();
      this.offset++;
      this.flowTrivia();
      while (this.current !== closer) {
        if (opener === "{") this.key(true, keys);
        this.flowTrivia();
        if (this.current !== closer && this.current !== ",") this.flowValue(depth + 1);
        else if (opener === "[") invalid();
        this.flowTrivia();
        if (this.current === closer) break;
        if (this.current !== ",") invalid();
        this.offset++;
        this.flowTrivia();
      }
      this.offset++;
    } else if (opener === '"' || opener === "'") this.quoted();
    else this.plain(true);
  }

  private inlineMapping(): boolean {
    const start = this.offset;
    if (!this.current || /^[[\]{},#?|>]/u.test(this.current)) return false;
    if (this.current === '"' || this.current === "'") this.quoted();
    else this.plain(false);
    this.skipHorizontal();
    const found = this.indicator(":");
    this.offset = start;
    return found;
  }

  private block(indent: number, depth: number, inline = false, indentlessSequence = false): void {
    if (depth > 100) invalid();
    let sequence: boolean | undefined;
    const keys = new Set<string>();
    while (!this.done) {
      if (!inline) {
        this.blankLines();
        if (this.done) return;
        const actual = this.indent();
        if (actual < indent) return;
        if (actual > indent) invalid();
        if (indentlessSequence && !this.sequenceAt(indent)) return;
        this.offset += indent;
      }
      inline = false;
      const item = this.indicator("-");
      if (sequence !== undefined && sequence !== item) invalid();
      sequence = item;
      const start = this.offset;
      if (item) this.offset++;
      else this.key(false, keys);
      this.skipHorizontal();
      if (this.current === "#") this.offset = this.lineEnd();
      if (this.current === "\n" || this.done) {
        this.endLine();
        this.blankLines();
        if (!this.done) {
          const nextIndent = this.indent();
          if (nextIndent > indent) this.block(nextIndent, depth + 1);
          else if (!item && nextIndent === indent && this.sequenceAt(indent)) this.block(indent, depth + 1, false, true);
        }
      } else if (item && (this.indicator("-") || this.inlineMapping())) {
        this.block(indent + this.offset - start, depth + 1, true);
      } else if (this.current === "|" || this.current === ">") {
        this.blockScalar(indent);
      } else {
        if (this.current === "[" || this.current === "{" || this.current === '"' || this.current === "'") this.flowValue(depth + 1);
        else this.plain(false);
        // The plain-scalar scanner has already consumed whitespace before a comment.
        if (this.current === "#" && /[ \t]/u.test(this.source[this.offset - 1] ?? "")) this.offset = this.lineEnd();
        this.endLine();
      }
    }
  }

  private sequenceAt(indent: number): boolean {
    const start = this.offset;
    this.offset += indent;
    const found = this.indicator("-");
    this.offset = start;
    return found;
  }

  private blockScalar(parentIndent: number): void {
    this.offset++;
    if (this.current === "+" || this.current === "-") this.offset++;
    this.endLine();
    let contentIndent: number | undefined;
    while (!this.done) {
      const end = this.lineEnd();
      const line = this.source.slice(this.offset, end);
      if (line.trim()) {
        const indent = this.indent();
        if (indent <= parentIndent) return;
        contentIndent ??= indent;
        if (indent < contentIndent) invalid();
      }
      this.offset = Math.min(end + 1, this.source.length);
    }
  }
}

export function hasPortableFrontmatter(markdown: string): boolean {
  const raw = markdown.replace(/^\uFEFF/u, "");
  if (!leadingMarker.test(raw)) return true;
  const lines = raw.split(/\r\n?|\n/u);
  if (!openingFence.test(lines[0]!)) return false;
  const end = lines.findIndex((line, index) => index > 0 && closingFence.test(line));
  if (end < 0) return false;
  const metadata = lines.slice(1, end);
  if (metadata.some(line => documentMarker.test(line))) return false;
  const body = metadata.join("\n");
  if (/(?![\t\n])[\p{Cc}\u2028\u2029]/u.test(body)) return false;
  try {
    new FrontmatterReader(body).read();
    return true;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
}
