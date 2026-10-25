/**
 * Models often write LaTeX inside JSON strings with a single backslash
 * ("\\times" written as "\times"). Plain JSON.parse then either throws on an
 * invalid escape ("\cdot", "\sqrt", "\le") or, worse, silently decodes a valid
 * escape: "\times" -> TAB + "imes", "\frac" -> FORM FEED + "rac",
 * "\beta" -> BACKSPACE + "eta", "\neq" -> NEWLINE + "eq", "\right" -> CR + "ight".
 *
 * escapeLatexInJsonStrings doubles backslashes inside JSON string literals when
 * they start a LaTeX command, leaving real JSON escapes (\n, \", \\, \uXXXX ...)
 * untouched. Commands that collide with a valid escape letter (t f b n r u) are
 * only treated as LaTeX when the whole word is a known command.
 */
const COLLIDING_LATEX: ReadonlySet<string> = new Set([
  // \t
  "times", "tau", "theta", "tan", "tanh", "text", "textbf", "textit", "textrm", "tfrac", "tilde", "to", "top", "triangle", "therefore", "tag",
  // \f
  "frac", "forall", "flat", "frown",
  // \b
  "beta", "bar", "bmod", "boxed", "binom", "bigcup", "bigcap", "bigl", "bigr", "big", "Big", "bot", "bullet", "because", "begin", "bf", "bmatrix", "backslash", "boldsymbol",
  // \n
  "nabla", "neq", "ne", "neg", "nu", "not", "notin", "nleq", "ngeq", "nmid", "newline", "nexists",
  // \r
  "rho", "right", "rightarrow", "Rightarrow", "rangle", "rceil", "rfloor", "rm", "rvert", "rVert",
  // \u
  "underline", "underbrace", "cup", "uparrow", "Uparrow", "upsilon",
]);

/**
 * LaTeX command names (without the backslash) whose first letter is also a JSON
 * escape letter. Shared with the stored-data repair below and its maintenance script.
 */
export const LATEX_COMMANDS_COLLIDING_WITH_JSON_ESCAPES: ReadonlySet<string> = COLLIDING_LATEX;

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

export function escapeLatexInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch !== "\\") { out += ch; continue; }
    const next = text[i + 1];
    if (next === undefined) { out += ch; continue; }
    if (next === '"' || next === "\\" || next === "/") { out += ch + next; i += 1; continue; }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += text.slice(i, i + 6); i += 5; continue; }
    const word = /^[A-Za-z]+/.exec(text.slice(i + 1))?.[0] ?? "";
    if (!VALID_ESCAPES.has(next)) {
      // Invalid JSON escape: always a literal backslash (LaTeX \cdot, \sqrt, \{ ...).
      out += "\\\\";
      continue;
    }
    if (word.length > 1 && COLLIDING_LATEX.has(word)) { out += "\\\\"; continue; }
    out += ch + next;
    i += 1;
  }
  return out;
}

/** JSON.parse that keeps single-backslash LaTeX intact. */
export function parseModelJson(text: string): unknown {
  return JSON.parse(escapeLatexInJsonStrings(text));
}

/** Control character JSON.parse produced from "\\<letter>" -> that letter. */
const DECODED_ESCAPE_LETTER: Readonly<Record<string, string>> = {
  "\t": "t", "\f": "f", "\b": "b", "\n": "n", "\r": "r",
};

/**
 * Undo LaTeX that a plain JSON.parse already decoded before parseModelJson existed:
 * TAB+"imes" -> "\\times", FF+"rac" -> "\\frac", BS+"eta" -> "\\beta",
 * LF+"eq" -> "\\neq", CR+"ight" -> "\\right".
 *
 * Only a control character followed by the rest of a whole known command word is
 * rewritten. Inside $...$ / $$...$$ every known command is repaired. Outside math a
 * real line break or tab before ordinary text is plausible, so LF/TAB are repaired only
 * when at least two letters follow and the result is not a likely English word on a new
 * line ("\\neq", "\\times", "\\nabla" yes; "\\ne" ("e.g."), "\\nu", "\\to", "\\tan" ("an"),
 * "\\top", "\\tag", "\\nmid" ("mid") no). FF/BS/CR never precede letters in real text.
 * Text stored before parseModelJson existed could not contain an invalid JSON escape
 * (JSON.parse threw on "\\cdot", "\\(", "\\$"), so "$" is the only math delimiter.
 */
const PROSE_LOOKALIKE_COMMANDS: ReadonlySet<string> = new Set(["tan", "top", "tag", "nmid"]);

export function repairDecodedLatexEscapes(text: string): { text: string; repairs: number } {
  if (!/[\t\f\b\n\r]/.test(text)) return { text, repairs: 0 };
  let out = "";
  let repairs = 0;
  let inlineMath = false;
  let displayMath = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "$") {
      if (text[i + 1] === "$") { displayMath = !displayMath; out += "$$"; i += 1; continue; }
      if (!displayMath) inlineMath = !inlineMath;
      out += ch;
      continue;
    }
    const letter = DECODED_ESCAPE_LETTER[ch];
    if (letter) {
      const rest = /^[A-Za-z]+/.exec(text.slice(i + 1))?.[0] ?? "";
      const command = letter + rest;
      const inMath = inlineMath || displayMath;
      const proseSafe = (ch !== "\n" && ch !== "\t") || (rest.length >= 2 && !PROSE_LOOKALIKE_COMMANDS.has(command));
      if (rest && COLLIDING_LATEX.has(command) && (inMath || proseSafe)) {
        out += "\\" + command;
        i += rest.length;
        repairs += 1;
        continue;
      }
    }
    out += ch;
  }
  return { text: out, repairs };
}

/** Apply repairDecodedLatexEscapes to every string value (never to object keys). */
export function repairDecodedLatexInJson<T>(value: T): { value: T; repairs: number } {
  let repairs = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const repaired = repairDecodedLatexEscapes(node);
      repairs += repaired.repairs;
      return repaired.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  const next = walk(value) as T;
  return { value: repairs ? next : value, repairs };
}
