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
const COLLIDING_LATEX = new Set([
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
