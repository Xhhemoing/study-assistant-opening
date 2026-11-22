import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import {
  FORBIDDEN_MISS_VARIANT_FIELDS,
  MAX_OFFLINE_LEASE_CARDS,
  OFFLINE_LEASE_TTL_MS,
  canonicalizeIdentifier,
  isSafeIdentifier,
  type IssueOfflineFlashcardLeaseInput,
  type IssueOfflineFlashcardLeaseResult,
  type OfflineEffectiveRating,
  type OfflineFlashcardLease,
  type OfflineFsrsMemoryState,
  type OfflineLeaseCard,
  type OfflineLeaseCardCandidate,
  type OfflineLeasedMissVariantCard,
  type OfflineLeasedStandardFlashcard,
  type OfflineOutboxEntryInput,
  type OfflineOutboxItemResult,
  type OfflineOutboxLedgerEntry,
  type OfflineOutboxPayloadSummary,
  type OfflineRawRating,
  type OfflineSettledReceipt,
  type ReconcileOfflineLeaseOutboxInput,
  type ReconcileOfflineLeaseOutboxResult,
  type ServerFlashcardSnapshot,
} from "./types";

const DAY_MS = 86_400_000;
const FSRS_ENGINE = fsrs({ request_retention: 0.9, enable_fuzz: false });

const EFFECTIVE_RATING_TO_FSRS: Record<OfflineEffectiveRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
};

const VALID_RAW_RATINGS: ReadonlySet<string> = new Set<OfflineRawRating>([
  "again",
  "hard",
  "good",
  "easy",
]);

const STRIPPABLE_CLIENT_PROMOTION_FLAGS = [
  "delayedCheck",
  "transferVerified",
  "promoteMastery",
] as const;

const SOLUTION_DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\\begin\s*\{\s*(?:solution|answer|answers|proof|rubric|key|grading|hint)\*?\s*\}/i,
  /(?:^|\n)\s*:{3,}\s*(?:solution|answer|rubric|key|grading)\b/i,
  /(?:^|\n)\s*`{3,}\s*(?:solution|answer|rubric|key|grading)\b/i,
  /<\s*(?:details|summary)\b/i,
  /\[\s*(?:answer|ans|solution|sol|key|rubric|canonical\s+solution|reference\s+answer)\s*[:：=]/i,
  /(?:\*\*|__)\s*(?:answer|ans|solution|canonical\s+solution|reference\s+answer|answer\s+key|grading\s+rubric)\s*[:：=]?\s*(?:\*\*|__)/i,
  /(?:\*|_)\s*(?:answer|ans|solution|canonical\s+solution|reference\s+answer|answer\s+key|grading\s+rubric)\s*(?:[:：=]\s*(?:\*|_)|(?:\*|_)\s*[:：=])/i,
  /(?:^|[\s,.;!?()[\]*_])(?:answer|ans|solution|canonical\s+solution|reference\s+answer|answer\s+key|grading\s+rubric)\s*(?:\*{1,3}|_{1,3})?\s*[:：=]/i,
  /(?:\*{1,3}|_{1,3})?(?:参考答案|标准答案|正确答案|答案|解析|解答|解题过程|评分标准|解)(?:\*{1,3}|_{1,3})?\s*[:：=]/,
];

const ALPHA_NUM_IDENT_CHAR =
  "[\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{N}_]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTokenBoundedSubstring(haystack: string, needle: string): boolean {
  const pattern = new RegExp(
    `(?<!${ALPHA_NUM_IDENT_CHAR})${escapeRegExp(needle)}(?!${ALPHA_NUM_IDENT_CHAR})`,
    "iu",
  );
  return pattern.test(haystack);
}

function normalizeLeakSyntax(text: string): string {
  const hasGroupingSpace = text.search(LOCALE_GROUPING_SPACE) !== -1;
  // NFKC folds these spaces to plain spaces. Preserve them long enough to
  // distinguish typographic digit grouping from separate numbers in prose.
  const normalized = (hasGroupingSpace
    ? text.replace(LOCALE_NON_GROUPING_RUN, part => part.normalize("NFKC"))
    : text.normalize("NFKC")).replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  const grouped = hasGroupingSpace || /\d,\d/.test(normalized)
    ? normalizeGroupedDecimals(normalized)
    : normalized;
  return hasGroupingSpace ? grouped.replace(LOCALE_GROUPING_SPACE, " ") : grouped;
}

function normalizeGroupedDecimals(text: string): string {
  type ContainerFrame = {
    index: number;
    close: string;
    itemStart: number;
    nestedItem: boolean;
    hasSeparator: boolean;
    validItems: boolean;
  };
  // Each frame validates only its top-level items. A completed child counts
  // as one item in its parent when surrounded by whitespace and separators.
  const openBrackets: ContainerFrame[] = [];
  const tupleBrackets = new Set<number>();
  const isNumericItem = (frame: ContainerFrame, end: number, allowEmpty = false): boolean => {
    if (!frame.validItems) return false;
    const item = text.slice(frame.itemStart, end).trim();
    if (frame.nestedItem) return item === "";
    return (allowEmpty && item === "") || NUMERIC_TUPLE_ITEM_RE.test(item);
  };
  for (const delimiter of text.matchAll(DECIMAL_CONTEXT_DELIMITER_RE)) {
    const token = delimiter[0];
    const offset = delimiter.index;
    const open = openBrackets.at(-1);
    const close = DECIMAL_CONTAINER_CLOSER.get(token);
    if (close !== undefined) {
      openBrackets.push({ index: offset, close, itemStart: offset + 1, nestedItem: false, hasSeparator: false, validItems: true });
      continue;
    }
    if (!open) continue;
    if (token === "," || token === ";") {
      open.validItems = isNumericItem(open, offset);
      open.hasSeparator = true;
      open.itemStart = offset + 1;
      open.nestedItem = false;
      continue;
    }
    if (open.close !== token) continue;
    openBrackets.pop();

    const numericContainer = isNumericItem(open, offset, !open.hasSeparator);
    if (numericContainer && open.hasSeparator) {
      tupleBrackets.add(open.index);
      tupleBrackets.add(offset);
    }
    const parent = openBrackets.at(-1);
    if (parent?.validItems) {
      parent.validItems = numericContainer && !parent.nestedItem && text.slice(parent.itemStart, open.index).trim() === "";
      parent.itemStart = offset + 1;
      parent.nestedItem = true;
    }
  }

  let depth = 0;
  return text.replace(GROUPED_DECIMAL_OR_BRACKET_RE, (token, offset: number) => {
    if (tupleBrackets.has(offset)) {
      depth += DECIMAL_CONTAINER_CLOSER.has(token) ? 1 : -1;
      return token;
    }
    const grouped = token.replace(LOCALE_GROUPING_SPACE, "_");
    const commaIndex = grouped.indexOf(",");
    if (commaIndex < 0 || depth > 0) return grouped;
    return grouped.slice(0, commaIndex).replace(/[.'’]/g, "_") + "." + grouped.slice(commaIndex + 1);
  });
}

function containsSolutionDirectiveMarker(stem: string): boolean {
  const syntax = normalizeLeakSyntax(stem);
  return SOLUTION_DIRECTIVE_PATTERNS.some(pattern => pattern.test(syntax));
}

function extractLeakSegments(normalizedSecret: string): string[] {
  const segments = new Set<string>([normalizedSecret]);
  for (const part of normalizedSecret.split(/[\n;]+|\.\s+|\bstep\s*\d+\s*[:.)]\s*/i)) {
    const trimmed = part.trim();
    if (trimmed.length >= 10 || (trimmed.length >= 6 && trimmed.split(/\s+/).length >= 3)) {
      segments.add(trimmed);
    }
  }
  return [...segments];
}

const SIGN_PREFIX = "(?:\\+-|-\\+|[+-])?";
const DECIMAL_DIGITS = /\d+(?:_\d+)*/.source;
const COMMA_GROUPED_INTEGER = /(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?!,\d)/.source;
const APOSTROPHE_GROUPED_INTEGER = /\d{1,3}(?:['’]\d{3})+(?!['’]\d)/.source;
const GROUPED_INTEGER = `(?:${COMMA_GROUPED_INTEGER}|${APOSTROPHE_GROUPED_INTEGER})`;
const DECIMAL_FRACTION = `\\.${DECIMAL_DIGITS}`;
const DECIMAL_EXPONENT = "[+-]?" + DECIMAL_DIGITS;
const OPTIONAL_DECIMAL_EXPONENT = "(?:[eE]" + DECIMAL_EXPONENT + ")?";
const GROUPED_DECIMAL = `${GROUPED_INTEGER}(?:${DECIMAL_FRACTION})?${OPTIONAL_DECIMAL_EXPONENT}`;
const UNGROUPED_DECIMAL = `(?:${DECIMAL_DIGITS}(?:${DECIMAL_FRACTION})?|${DECIMAL_FRACTION})${OPTIONAL_DECIMAL_EXPONENT}`;
const UNSIGNED_DECIMAL_LITERAL = `(?:${GROUPED_DECIMAL}|${UNGROUPED_DECIMAL})`;
const DECIMAL_LITERAL_RE = new RegExp(`^${SIGN_PREFIX}${UNSIGNED_DECIMAL_LITERAL}$`);
const DECIMAL_VALUE_RE = new RegExp(
  `^([+-]?)(${GROUPED_INTEGER}|${DECIMAL_DIGITS})?(?:\\.(${DECIMAL_DIGITS}))?(?:[eE](${DECIMAL_EXPONENT}))?$`,
);
const GREEK_LETTER_NAMES = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "varepsilon",
  "zeta",
  "eta",
  "theta",
  "vartheta",
  "iota",
  "kappa",
  "varkappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "omicron",
  "pi",
  "varpi",
  "rho",
  "varrho",
  "sigma",
  "varsigma",
  "tau",
  "upsilon",
  "phi",
  "varphi",
  "chi",
  "psi",
  "omega",
] as const;

const MATH_CONST_NAMES = ["inf", "infty", "infinity"] as const;

const MATH_FUNCTION_NAMES = [
  "sqrt",
  "sin",
  "cos",
  "tan",
  "log",
  "ln",
  "exp",
  "abs",
  "min",
  "max",
] as const;

const GREEK_OR_CONST = `(?:${[...GREEK_LETTER_NAMES, ...MATH_CONST_NAMES].join("|")})`;
const GREEK_OR_CONST_LABEL_RE = new RegExp(`^${GREEK_OR_CONST}$`, "i");

const GREEK_NAME_VARIANTS = new Map<string, string>([
  ["varepsilon", "epsilon"], ["vartheta", "theta"], ["varkappa", "kappa"],
  ["varpi", "pi"], ["varrho", "rho"], ["varsigma", "sigma"], ["varphi", "phi"],
]);
const GREEK_SYMBOLS = "αβγδεζηθικλμνξοπρστυφχψω";
const GREEK_SYMBOL_VARIANTS = new Map<string, string>([
  ["ϵ", "ε"], ["ϑ", "θ"], ["ϰ", "κ"], ["ϖ", "π"], ["ϱ", "ρ"], ["ς", "σ"], ["ϕ", "φ"], ["ϐ", "β"],
]);
const GREEK_SYMBOL_NAMES = GREEK_LETTER_NAMES.filter(name => !GREEK_NAME_VARIANTS.has(name));
const LATEX_GREEK_COMMAND_RE = new RegExp(
  "(?<!\\\\)\\\\(" + GREEK_LETTER_NAMES.join("|") + ")(?![A-Za-z])",
  "gi",
);
const ASCII_GREEK_VARIANT_RE = new RegExp(
  "(?<!" + ALPHA_NUM_IDENT_CHAR + ")(?:" + [...GREEK_NAME_VARIANTS.keys()].join("|") + ")(?!" + ALPHA_NUM_IDENT_CHAR + ")",
  "giu",
);

const SHORT_NUMERIC_OR_SYMBOLIC_ANSWER_RE = new RegExp(
  `^(?:` +
    `${SIGN_PREFIX}${UNSIGNED_DECIMAL_LITERAL}(?:\\/\\d+)?` +
    `|${SIGN_PREFIX}(?:${GREEK_OR_CONST}|sqrt\\([^)]+\\)|[a-z]\\^\\d+)(?:\\/[a-z0-9]+)?` +
    `|${SIGN_PREFIX}\\d+(?:\\/\\d+)?\\s*(?:${GREEK_OR_CONST}|sqrt\\([^)]+\\))` +
    `|${SIGN_PREFIX}[a-z0-9]+(?:[*\\/][a-z0-9]+)+` +
    `|${SIGN_PREFIX}\\d+[a-z](?:\\^\\d+)?` +
  `)$`,
  "i",
);

const UNICODE_MATH_SYMBOL_RE = /[\p{Sm}\p{Script=Greek}]/u;
const RELATION_OP_RE = /(?:<=|>=|!=|~=|==|=|<|>)/;
const SINGLE_CHOICE_LETTER_RE = /^[a-z]$/i;

const UNICODE_MULTIPLICATION_RE = /[\u00D7\u00B7\u22C5\u2219\u2217]/g;
const UNICODE_MATH_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2212\u2013\u2014\u2010\u2011\uFE63\uFF0D]/g, "-"],
  [/\u00B1\s*(?=[a-z0-9(\u221A\p{Script=Greek}])/giu, "+-"],
  [/\u00B1/g, "+-"],
  [/\u2213\s*(?=[a-z0-9(\u221A\p{Script=Greek}])/giu, "-+"],
  [/\u2213/g, "-+"],
  [UNICODE_MULTIPLICATION_RE, "*"],
  [/[\u00F7\u2215\u2044]/g, "/"],
  [/\u2264/g, "<="],
  [/\u2265/g, ">="],
  [/\u2260/g, "!="],
  [/\u2248/g, "~="],
  [/\u221E/g, "inf"],
  [/\u221A\s*\(/g, "sqrt("],
  [/\u221A\s*([a-z0-9]+(?:\.[a-z0-9]+)?)/gi, "sqrt($1)"],
  [/\u221A/g, "sqrt"],
  [/\bsqrt\s*([0-9]+(?:\.[0-9]+)?)/gi, "sqrt($1)"],
  [/[\u2032\u2019]/g, "'"],
];

const MATH_OPERAND_LOOKAHEAD =
  `(?=\\d|\\.|sqrt\\(|(?:${GREEK_OR_CONST})\\b)`;

const LATEX_ZERO_ARG_NON_OPERAND_COMMANDS: ReadonlySet<string> = new Set([
  "quad",
  "qquad",
  "enspace",
  "thinspace",
  "medspace",
  "thickspace",
  "space",
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "scriptscriptstyle",
]);

const LATEX_ONE_ARG_NON_OPERAND_COMMANDS: ReadonlySet<string> = new Set([
  "color",
  "pagecolor",
  "textcolor",
  "colorbox",
  "hspace",
  "vspace",
  "phantom",
  "hphantom",
  "vphantom",
  "begin",
  "end",
  "label",
  "style",
  "class",
  "cssid",
]);

const LATEX_TWO_ARG_NON_OPERAND_COMMANDS: ReadonlySet<string> = new Set([
  "rule",
  "fcolorbox",
]);

const LATEX_SKIP_DIM_COMMANDS: ReadonlySet<string> = new Set([
  "kern",
  "mkern",
  "mskip",
  "hskip",
]);

const LATEX_CONTROL_SPACE_CHARS = new Set([",", ";", ":", "!", " "]);
const LATEX_OPTION_FORMATTING_COMMANDS = new Set([
  "text", "textbf", "textit", "texttt", "textsf", "textsc", "textsl", "textmd", "textrm",
  "textnormal", "textup", "emph", "mathrm", "mathbf", "mathit", "mathsf", "mathtt",
  "mathcal", "mathbb", "mathfrak", "mathscr", "mathnormal", "boldsymbol", "bm",
]);

const LATEX_DIM_PREFIX_RE =
  /^\s*[+-]?\d+(?:\.\d+)?\s*(?:em|ex|pt|px|mu|cm|mm|in|pc|bp|dd|cc|sp)\b/i;

function skipBalancedGroup(text: string, start: number, openChar: string, closeChar: string): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  if (text[i] !== openChar) return -1;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * Strips non-operand LaTeX spacing, styling, layout, and environment commands
 * (`\quad`, `\color{red}`, `\textcolor{red}` prefix, `\pagecolor{...}`, `\hspace{...}`,
 * `\phantom{...}`, `\begin{...}`, `\end{...}`, `\rule{...}{...}`, `\style{...}`, etc.)
 * to single spaces so their closing braces never masquerade as binary left operands.
 */
function stripLatexNonOperandCommands(text: string, unwrapOptionFormatting = false): string {
  const formattingClosers = unwrapOptionFormatting ? new Map<number, number>() : undefined;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const bodyStart = formattingClosers?.get(i);
    if (bodyStart !== undefined) {
      const before = out.slice(0, bodyStart);
      out = before + preserveFormattedChoice(out.slice(bodyStart), before, text.slice(i + 1));
      i += 1;
      continue;
    }
    if (text[i] !== "\\") {
      out += text[i];
      i += 1;
      continue;
    }
    if (i + 1 >= text.length) {
      out += "\\";
      break;
    }
    const nextChar = text[i + 1] ?? "";
    if (nextChar === "\\") {
      out += "\\\\";
      i += 2;
      continue;
    }
    if (LATEX_CONTROL_SPACE_CHARS.has(nextChar)) {
      out += " ";
      i += 2;
      continue;
    }
    if (!/[A-Za-z]/.test(nextChar)) {
      out += `\\${nextChar}`;
      i += 2;
      continue;
    }
    let nameEnd = i + 1;
    while (nameEnd < text.length && /[A-Za-z]/.test(text[nameEnd] ?? "")) {
      nameEnd += 1;
    }
    const cmdLower = text.slice(i + 1, nameEnd).toLowerCase();

    if (formattingClosers && LATEX_OPTION_FORMATTING_COMMANDS.has(cmdLower)) {
      const argEnd = skipBalancedGroup(text, nameEnd, "{", "}");
      if (argEnd !== -1) {
        formattingClosers.set(argEnd - 1, out.length);
        i = text.indexOf("{", nameEnd) + 1;
        continue;
      }
    }

    if (LATEX_ZERO_ARG_NON_OPERAND_COMMANDS.has(cmdLower)) {
      out += " ";
      i = nameEnd;
      continue;
    }

    if (LATEX_SKIP_DIM_COMMANDS.has(cmdLower)) {
      const bracedEnd = skipBalancedGroup(text, nameEnd, "{", "}");
      if (bracedEnd !== -1) {
        out += " ";
        i = bracedEnd;
        continue;
      }
      const dimMatch = LATEX_DIM_PREFIX_RE.exec(text.slice(nameEnd));
      if (dimMatch) {
        out += " ";
        i = nameEnd + dimMatch[0].length;
        continue;
      }
      out += " ";
      i = nameEnd;
      continue;
    }

    if (cmdLower === "tag") {
      let cursor = nameEnd;
      while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
      const isStarred = text[cursor] === "*";
      if (isStarred) cursor += 1;
      const argEnd = skipBalancedGroup(text, cursor, "{", "}");
      if (argEnd !== -1) {
        let openBrace = cursor;
        while (openBrace < argEnd && text[openBrace] !== "{") openBrace += 1;
        const inner = stripLatexNonOperandCommands(text.slice(openBrace + 1, argEnd - 1), unwrapOptionFormatting);
        out += isStarred ? ` ; ${inner} ` : ` (${inner}) `;
        i = argEnd;
        continue;
      }
      out += " ; ";
      i = cursor;
      continue;
    }

    if (LATEX_ONE_ARG_NON_OPERAND_COMMANDS.has(cmdLower)) {
      let cursor = nameEnd;
      if (text[cursor] === "*") cursor += 1;
      const optEnd = skipBalancedGroup(text, cursor, "[", "]");
      if (optEnd !== -1) cursor = optEnd;
      const argStart = cursor;
      const argEnd = skipBalancedGroup(text, cursor, "{", "}");
      if (argEnd !== -1) {
        cursor = argEnd;
        if (cmdLower === "begin") {
          const postOptEnd = skipBalancedGroup(text, cursor, "[", "]");
          if (postOptEnd !== -1) cursor = postOptEnd;
          const envName = text.slice(argStart, argEnd).trim().slice(1, -1).trim().toLowerCase();
          if (envName === "array" || envName === "tabular") {
            const colSpecEnd = skipBalancedGroup(text, cursor, "{", "}");
            if (colSpecEnd !== -1) cursor = colSpecEnd;
          }
        }
        out += " ";
        i = cursor;
        continue;
      }
    }

    if (LATEX_TWO_ARG_NON_OPERAND_COMMANDS.has(cmdLower)) {
      let cursor = nameEnd;
      const optEnd = skipBalancedGroup(text, cursor, "[", "]");
      if (optEnd !== -1) cursor = optEnd;
      const arg1End = skipBalancedGroup(text, cursor, "{", "}");
      if (arg1End !== -1) {
        const arg2End = skipBalancedGroup(text, arg1End, "{", "}");
        if (arg2End !== -1) {
          out += " ";
          i = arg2End;
          continue;
        }
      }
    }

    out += text.slice(i, nameEnd);
    i = nameEnd;
  }
  return out;
}

function findMathRanges(text: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      const next = text[i + 1];
      if (next === "(") {
        const closeIdx = text.indexOf("\\)", i + 2);
        if (closeIdx !== -1) {
          ranges.push([i, closeIdx + 2]);
          i = closeIdx + 2;
          continue;
        }
      } else if (next === "[") {
        const closeIdx = text.indexOf("\\]", i + 2);
        if (closeIdx !== -1) {
          ranges.push([i, closeIdx + 2]);
          i = closeIdx + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    if (text[i] === "$") {
      if (text[i + 1] === "$") {
        let closeIdx = text.indexOf("$$", i + 2);
        while (closeIdx !== -1 && text[closeIdx - 1] === "\\") {
          closeIdx = text.indexOf("$$", closeIdx + 2);
        }
        if (closeIdx !== -1) {
          ranges.push([i, closeIdx + 2]);
          i = closeIdx + 2;
          continue;
        }
      } else {
        let closeIdx = i + 1;
        while (closeIdx < text.length) {
          if (text[closeIdx] === "\\" && closeIdx + 1 < text.length) {
            closeIdx += 2;
            continue;
          }
          if (text[closeIdx] === "$") {
            ranges.push([i, closeIdx + 1]);
            i = closeIdx + 1;
            break;
          }
          closeIdx += 1;
        }
        if (closeIdx < text.length) continue;
      }
    }
    i += 1;
  }
  return ranges;
}

function isInsideMathRange(index: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

const DEFINITE_BINARY_LEFT_OPERAND_END_RE = new RegExp(
  `(?:[\\d}|'\\u2032\\u2019]|(?<![\\p{L}\\p{N}_])[B-HJ-Zb-hj-z\\p{Script=Greek}]|[A-Za-z\\p{Script=Greek}]_[A-Za-z0-9\\p{Script=Greek}]+|\\\\[A-Za-z]+|\\b(?:${GREEK_OR_CONST}))\\s*$`,
  "iu",
);

const CLOSING_GROUP_END_RE = /[)\]]\s*$/;

const AMBIGUOUS_PROSE_SINGLE_LETTER_END_RE = /(?<![\p{L}\p{N}_])[aAiI]\s*$/u;

const DIRECT_MATH_CALL_PREFIX_RE = new RegExp(
  `(?:[\\d)'\\u2032\\u2019]|(?<![\\p{L}\\p{N}_])[A-Za-z\\p{Script=Greek}]|[A-Za-z\\p{Script=Greek}]_[A-Za-z0-9\\p{Script=Greek}]+|\\\\[A-Za-z]+|\\b(?:${MATH_FUNCTION_NAMES.join("|")}))$`,
  "iu",
);

const MATH_PROSE_CONJUNCTIONS: ReadonlySet<string> = new Set([
  "where",
  "when",
  "if",
  "for",
  "and",
  "or",
]);

const ALGEBRAIC_EXPR_WORDS: ReadonlySet<string> = new Set([
  ...GREEK_LETTER_NAMES,
  ...MATH_CONST_NAMES,
  ...MATH_FUNCTION_NAMES,
]);

const GROUP_ARITHMETIC_OP_RE = /^[+\-*/^\u2212\u00D7\u00F7\u00B7\u22C5\u2215\u2044]$/;
const GROUP_MATH_AUX_CHAR_RE = /^[\d|'\u2032\u2019\u221A!_()[\]{}]$/;

const LEADING_ALGEBRAIC_RELATION_RE =
  /^(?:<=|>=|!=|~=|==|=|<|>|\u2264|\u2265|\u2260|\u2248|\u2261|\\(?:le|leq|ge|geq|ne|neq|approx|equiv)\b)/i;

const TRAILING_ALGEBRAIC_RELATION_RE =
  /(?:<=|>=|!=|~=|==|=|<|>|\u2264|\u2265|\u2260|\u2248|\u2261|\\(?:le|leq|ge|geq|ne|neq|approx|equiv))$/i;

const DIRECT_LEFT_VAR_CONNECTOR_END_RE =
  /(?:[=<>+\-*/^([{\u2212\u00D7\u00F7\u00B7\u2264\u2265\u2260\u2248\u2261]|\\(?:le|leq|ge|geq|ne|neq|approx|equiv|cdot|times)|\b(?:sin|cos|tan|log|ln|exp|min|max))\s*$/i;

const ALGEBRAIC_SYMBOL_CHAR_RE = /^[\d.+\-*/^|'\u2032\u2019\u2212\u00D7\u00F7\u00B7\u221A!%_]$/;

const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
const ABBREVIATION_END_RE = /(?<![\p{L}\p{N}_])(e\.g|i\.e|cf|vs|viz|etc|approx)$/iu;
const SENTENCE_START_AFTER_ABBREVIATION_RE = /^(?:\s+\p{Lu}\p{Ll}|\s*\p{Script=Han})/u;
const BRACKETED_ITEM_MARKER = "(?:\\([A-Za-z0-9]+\\)|\\[[A-Za-z0-9]+\\])";
const NUMBERED_ITEM_MARKER = `(?:\\d+[.)]?\\s*${BRACKETED_ITEM_MARKER}|\\d+(?:[A-Za-z]|\\s*)(?:\\)|\\.(?!\\d)))`;
const ITEM_MARKER_AFTER_ABBREVIATION_RE = new RegExp(
  `^\\s*(?:${NUMBERED_ITEM_MARKER}|${BRACKETED_ITEM_MARKER})`,
);
const ITEM_CONTENT_START =
  String.raw`(?:\p{L}{2}|[A-Za-z]\s*(?::=|=(?![=>])|∈|\\in\b)|\$[^$\r\n]+\$)`;
const ITEM_START_SEPARATOR = String.raw`(?:\s+|\s*[:：.;,\-–—]\s*)`;
const DELIMITED_ITEM_START = `${ITEM_START_SEPARATOR}${ITEM_CONTENT_START}`;
const ITEM_MARKER_FOLLOW = `(?=$|[\\s:：\\p{L}]|${DELIMITED_ITEM_START})`;
const ITEM_MARKER_WITHIN_SENTENCE_RE = new RegExp(
  `(?<=^|[\\s,，、:：])(?<![=+*/^−-]\\s*)(?:${NUMBERED_ITEM_MARKER}|(?:[Ee]xercise|[Pp]roblem|[Qq]uestion|[Pp]art|[Ii]tem)\\s+\\d+)${ITEM_MARKER_FOLLOW}|` +
    `(?<=(?:^|[,，、:：])\\s*)${BRACKETED_ITEM_MARKER}${ITEM_MARKER_FOLLOW}|` +
    `(?<=\\s)(?<![=+*/^−-]\\s*)${BRACKETED_ITEM_MARKER}(?=${DELIMITED_ITEM_START})|` +
    `(?<=^|[\\s,，、:：])(?<![=+*/^−-]\\s*)(?<bareLetter>[A-Za-z]\\))(?=${ITEM_START_SEPARATOR}?${ITEM_CONTENT_START})`,
  "gu",
);
const POSTFIX_APPROXIMATION_RE = /\d\s+approx$/i;
const APPROXIMATE_NUMBER_RE = /^\s*[+−-]?(?:\d|\.\d)/u;

function isSentenceDelimiter(text: string, index: number): boolean {
  const ch = text[index];
  if (ch && /[\r\n\u2028\u2029;；！？?。]/u.test(ch)) {
    return true;
  }
  if (ch === "!") {
    return text[index + 1] !== "=";
  }
  if (ch !== ".") return false;
  const before = text.slice(Math.max(0, index - 7), index);
  const after = text.slice(index + 1, index + 3).toLowerCase();
  // The first periods in e.g. and i.e. are internal to the abbreviations.
  if (after === "g." && /(?<![\p{L}\p{N}_])e$/iu.test(before)) return false;
  if (after === "e." && /(?<![\p{L}\p{N}_])i$/iu.test(before)) return false;
  const abbreviation = ABBREVIATION_END_RE.exec(before)?.[1]?.toLowerCase();
  if (!abbreviation) return !/\d/.test(text[index + 1] ?? "");
  if (abbreviation === "etc") return true;

  const remainder = text.slice(index + 1);
  if (
    SENTENCE_START_AFTER_ABBREVIATION_RE.test(remainder) ||
    ITEM_MARKER_AFTER_ABBREVIATION_RE.test(remainder)
  ) {
    return true;
  }
  return abbreviation === "approx" && (
    POSTFIX_APPROXIMATION_RE.test(text.slice(0, index)) || !APPROXIMATE_NUMBER_RE.test(remainder)
  );
}

function isClauseDelimiter(text: string, index: number): boolean {
  return /[,，、:：]/u.test(text[index] ?? "") || isSentenceDelimiter(text, index);
}

function findContextStart(
  text: string,
  index: number,
  isDelimiter: (text: string, index: number) => boolean,
): number {
  while (index > 0 && !isDelimiter(text, index - 1)) index -= 1;
  return index;
}

function extractLocalClauseRange(
  text: string,
  startIndex: number,
  endIndex: number,
): readonly [number, number] {
  const start = findContextStart(text, startIndex, isClauseDelimiter);
  let end = endIndex;
  while (end < text.length && !isClauseDelimiter(text, end)) {
    end += 1;
  }
  return [start, end];
}

function hasDirectRightAlgebraicRelation(segment: string): boolean {
  let i = 0;
  let groupDepth = 0;
  while (i < segment.length) {
    const ch = segment[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (groupDepth === 0 && LEADING_ALGEBRAIC_RELATION_RE.test(segment.slice(i))) {
      return true;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      groupDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (groupDepth > 0) groupDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      let cmdEnd = i + 1;
      while (cmdEnd < segment.length && /[A-Za-z]/.test(segment[cmdEnd] ?? "")) cmdEnd += 1;
      if (cmdEnd > i + 1) {
        i = cmdEnd;
        continue;
      }
      return false;
    }
    if (ALGEBRAIC_SYMBOL_CHAR_RE.test(ch) || /\p{Script=Greek}/u.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let wordEnd = i + 1;
      while (wordEnd < segment.length && /[A-Za-z]/.test(segment[wordEnd] ?? "")) wordEnd += 1;
      const word = segment.slice(i, wordEnd).toLowerCase();
      if (word.length === 1 || ALGEBRAIC_EXPR_WORDS.has(word)) {
        i = wordEnd;
        continue;
      }
      return false;
    }
    return false;
  }
  return false;
}

function hasDirectLeftAlgebraicRelation(segment: string): boolean {
  if (!DIRECT_LEFT_VAR_CONNECTOR_END_RE.test(segment)) {
    return false;
  }
  let i = segment.length;
  let closeDepth = 0;
  while (i > 0) {
    const ch = segment[i - 1] ?? "";
    if (/\s/.test(ch)) {
      i -= 1;
      continue;
    }
    if (closeDepth === 0 && TRAILING_ALGEBRAIC_RELATION_RE.test(segment.slice(0, i))) {
      return true;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      closeDepth += 1;
      i -= 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      if (closeDepth > 0) closeDepth -= 1;
      i -= 1;
      continue;
    }
    if (ALGEBRAIC_SYMBOL_CHAR_RE.test(ch) || /\p{Script=Greek}/u.test(ch)) {
      i -= 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let wordStart = i - 1;
      while (wordStart > 0 && /[A-Za-z]/.test(segment[wordStart - 1] ?? "")) wordStart -= 1;
      if (wordStart > 0 && segment[wordStart - 1] === "\\") {
        i = wordStart - 1;
        continue;
      }
      const word = segment.slice(wordStart, i).toLowerCase();
      if (word.length === 1 || ALGEBRAIC_EXPR_WORDS.has(word)) {
        i = wordStart;
        continue;
      }
      return false;
    }
    return false;
  }
  return false;
}

function findMatchingGroupOpen(text: string, closeIndex: number): number {
  const closeChar = text[closeIndex];
  const openChar = closeChar === ")" ? "(" : closeChar === "]" ? "[" : "";
  if (!openChar) return -1;
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (i > 0 && text[i - 1] === "\\") continue;
    const ch = text[i];
    if (ch === closeChar) {
      depth += 1;
    } else if (ch === openChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function analyzeAlgebraicGroupInner(inner: string): {
  readonly isPureAlgebraic: boolean;
  readonly hasArithmeticOperator: boolean;
} {
  let hasArithmeticOperator = false;
  let hasOperandToken = false;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === ".") {
      if (/\d/.test(inner[i + 1] ?? "")) {
        hasOperandToken = true;
        i += 1;
        continue;
      }
      return { isPureAlgebraic: false, hasArithmeticOperator: false };
    }
    if (GROUP_ARITHMETIC_OP_RE.test(ch)) {
      hasArithmeticOperator = true;
      i += 1;
      continue;
    }
    if (GROUP_MATH_AUX_CHAR_RE.test(ch) || /\p{Script=Greek}/u.test(ch)) {
      if (/\d|\p{Script=Greek}/u.test(ch)) hasOperandToken = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      let cmdEnd = i + 1;
      while (cmdEnd < inner.length && /[A-Za-z]/.test(inner[cmdEnd] ?? "")) cmdEnd += 1;
      if (cmdEnd > i + 1) {
        hasOperandToken = true;
        i = cmdEnd;
        continue;
      }
      return { isPureAlgebraic: false, hasArithmeticOperator: false };
    }
    if (/[A-Za-z]/.test(ch)) {
      let wordEnd = i + 1;
      while (wordEnd < inner.length && /[A-Za-z]/.test(inner[wordEnd] ?? "")) wordEnd += 1;
      const word = inner.slice(i, wordEnd).toLowerCase();
      if (word.length === 1 || ALGEBRAIC_EXPR_WORDS.has(word)) {
        hasOperandToken = true;
        i = wordEnd;
        continue;
      }
      return { isPureAlgebraic: false, hasArithmeticOperator: false };
    }
    return { isPureAlgebraic: false, hasArithmeticOperator: false };
  }
  return { isPureAlgebraic: hasOperandToken, hasArithmeticOperator };
}

function hasDirectClauseAlgebraicRelation(
  text: string,
  exprStart: number,
  operandEndIndex: number,
): boolean {
  const [clauseStart, clauseEnd] = extractLocalClauseRange(text, exprStart, operandEndIndex);
  const clauseBeforeExpr = text.slice(clauseStart, exprStart);
  const clauseAfterOperand = text.slice(operandEndIndex, clauseEnd);
  if (
    !hasDirectRightAlgebraicRelation(clauseAfterOperand) &&
    !hasDirectLeftAlgebraicRelation(clauseBeforeExpr)
  ) {
    return false;
  }
  const trailingWordMatch = /^\s+([A-Za-z]{2,})\b/.exec(clauseAfterOperand);
  if (trailingWordMatch) {
    const trailingWord = (trailingWordMatch[1] ?? "").toLowerCase();
    if (!MATH_PROSE_CONJUNCTIONS.has(trailingWord) && !ALGEBRAIC_EXPR_WORDS.has(trailingWord)) {
      return false;
    }
  }
  return true;
}

const ENGLISH_MATH_OBJECT =
  "(?:(?:the|this)\\s+)?(?:following\\s+)?" +
  "(?:(?:algebraic|mathematical|numeric(?:al)?|rational)\\s+)?" +
  "(?:expression|formula|quantity|quotient|difference|sum|product|term|equation|inequality|function|value)";
const ENGLISH_MATH_DIRECTIVE_RE = new RegExp(
  "^(?:(?:(?:step|part|item|question|problem|exercise)\\s+[a-z0-9]+|\\([a-z0-9]+\\)|\\d+[.)])\\s+)?" +
    "(?:(?:please|first|second|third|next|then|now|finally|lastly|also|hence|thus|therefore)\\s+)*" +
    "(?:evaluate|simplify|compute|calculate|expand|factor|solve|prove|verify|check|find|determine)" +
    `(?:\\s+(?:(?:the\\s+)?value\\s+of(?:\\s+${ENGLISH_MATH_OBJECT})?|${ENGLISH_MATH_OBJECT}))?$`,
  "i",
);

const CJK_MATH_DIRECTIVE_RE = new RegExp(
  "^(?:第[一二三四五六七八九十\\d]+[步题问]\\s*)?" +
    "(?:(?:请|首先|其次|先|接着|然后|最后|现在|再)\\s*)*" +
    "(?:计算|求值|化简|展开|因式分解|解方程|求解|证明|验证|核算|[解求设令若当]|已知)" +
    "(?:\\s*(?:下列|以下|该|此|本)?(?:代数式|数学式|表达式|算式|式子|分式|方程|不等式|函数|值)" +
    "(?:的(?:数值|值|结果))?)?$",
  "u",
);

const MATH_OPERATOR_BEFORE_GROUP_RE =
  /(?:[+\-\u2212*\u00D7\u00B7\u22C5/\u00F7\u2215\u2044^=<>\u2264\u2265\u2260\u2248\u2261([]|\\(?:le|leq|ge|geq|ne|neq|approx|equiv|cdot|times))\s*$/i;

const TRAILING_CJK_PROSE_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\s*$/u;

const PHYSICAL_UNIT_TOKENS: ReadonlySet<string> = new Set([
  // Lowercase single-letter SI/time/mass/length units
  "m",
  "s",
  "g",
  "h",
  "l",
  // Uppercase-only single-letter SI units so lowercase algebra (`v/t`, `a/b`, `n/m^2`) stays algebraic
  "V",
  "A",
  "N",
  "J",
  "W",
  "C",
  "K",
  "F",
  "T",
  "H",
  // Multi-letter SI and common physical units (exact SI casing)
  "ms",
  "km",
  "cm",
  "mm",
  "nm",
  "hr",
  "min",
  "kg",
  "mg",
  // Both liter spellings and their prefixed forms.
  "L",
  "mL",
  "ml",
  "dL",
  "dl",
  "kL",
  "kl",
  "μL",
  "μl",
  "uL",
  "ul",
  // Canonicalized micro-liter spellings after Greek symbol substitution.
  "muL",
  "mul",
  "mol",
  "mmol",
  "Pa",
  "kPa",
  "MPa",
  "kJ",
  "MJ",
  "cal",
  "kcal",
  "kW",
  "MW",
  "mW",
  "mV",
  "kV",
  "mA",
  "Hz",
  "kHz",
  "MHz",
  "GHz",
  "rad",
  "deg",
  "ft",
  "mi",
  "lb",
  "oz",
]);

const UNIT_CONNECTOR_CHAR_RE = /^[*/\u00D7\u00F7\u00B7\u22C5\u2219\u2217\u2215\u2044]$/;
const UNIT_LETTER_RE = /^[A-Za-zμ]$/u;
const UNIT_EXPONENT_RE = /^(?:\^\s*(?:\(\s*[-−]?\d+\s*\)|[-−]?\d+)|[-−]?\d+)/u;

function isMathDirectivePhrase(phrase: string): boolean {
  return (
    ENGLISH_MATH_DIRECTIVE_RE.test(phrase) ||
    /^(?:let|if|when|where|given)$/i.test(phrase) ||
    CJK_MATH_DIRECTIVE_RE.test(phrase)
  );
}

function hasMathDirective(prefix: string): boolean {
  const clause = prefix.trim();
  if (isMathDirectivePhrase(clause)) return true;

  // Test the entire clause first so a step marker such as (b) stays intact.
  const lastOpeningBracket = Math.max(clause.lastIndexOf("("), clause.lastIndexOf("["));
  return lastOpeningBracket !== -1 && isMathDirectivePhrase(clause.slice(lastOpeningBracket + 1).trimStart());
}

function hasNonMathProseBeforeGroup(prefix: string): boolean {
  if (TRAILING_CJK_PROSE_CHAR_RE.test(prefix)) {
    return true;
  }
  const wordMatch = /(?<![\\\p{L}\p{N}_])([\p{L}]{2,})\s*$/u.exec(prefix);
  if (!wordMatch) {
    return false;
  }
  const word = (wordMatch[1] ?? "").toLowerCase();
  return !ALGEBRAIC_EXPR_WORDS.has(word);
}

function parsePhysicalUnitGroupTokens(inner: string): readonly string[] | null {
  let i = 0;
  const tokens: string[] = [];
  let hasMultiLetterUnit = false;
  let expectAtom = true;
  const closingBrackets: string[] = [];
  while (i < inner.length) {
    const ch = inner[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[") {
      if (!expectAtom) return null;
      closingBrackets.push(ch === "(" ? ")" : "]");
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      if (expectAtom || closingBrackets.pop() !== ch) return null;
      i += 1 + (UNIT_EXPONENT_RE.exec(inner.slice(i + 1))?.[0].length ?? 0);
      continue;
    }
    if (UNIT_CONNECTOR_CHAR_RE.test(ch)) {
      if (expectAtom) return null;
      expectAtom = true;
      i += 1;
      continue;
    }
    if (expectAtom && UNIT_LETTER_RE.test(ch)) {
      let wordEnd = i + 1;
      while (UNIT_LETTER_RE.test(inner[wordEnd] ?? "")) wordEnd += 1;
      const token = inner.slice(i, wordEnd);
      if (!PHYSICAL_UNIT_TOKENS.has(token)) {
        return null;
      }
      tokens.push(token);
      if (token.length >= 2) hasMultiLetterUnit = true;
      i = wordEnd + (UNIT_EXPONENT_RE.exec(inner.slice(wordEnd))?.[0].length ?? 0);
      expectAtom = false;
      continue;
    }
    return null;
  }
  if (closingBrackets.length || expectAtom || (tokens.length < 2 && !hasMultiLetterUnit)) {
    return null;
  }
  return tokens;
}

function areGroupUnitTokensBoundInSentence(
  unitTokens: readonly string[],
  text: string,
  groupStart: number,
  operandEnd: number,
): boolean {
  const start = findContextStart(text, groupStart, isSentenceDelimiter);
  let end = operandEnd;
  while (end < text.length && !isSentenceDelimiter(text, end)) end += 1;
  const sentence = text.slice(start, end);
  let itemStart = 0;
  let itemEnd = sentence.length;
  for (const marker of sentence.matchAll(ITEM_MARKER_WITHIN_SENTENCE_RE)) {
    const markerEnd = marker.index + marker[0].length;
    if (marker.groups?.bareLetter && findMatchingGroupOpen(sentence, markerEnd - 1) !== -1) {
      continue;
    }
    if (markerEnd <= groupStart - start) {
      itemStart = markerEnd;
    } else if (marker.index >= operandEnd - start) {
      itemEnd = marker.index;
      break;
    }
  }
  const item = sentence.slice(itemStart, itemEnd);
  for (const token of unitTokens) {
    if (token.length !== 1) return false;
    const bindingRe = new RegExp(
      `(?<!${NON_CJK_WORD_CHAR}|[+*/^×÷]\\s*)${token}\\s*=\\s*(?=[A-Za-z\\p{Script=Greek}\\d(\\[\\\\+−\\-√]|\\.\\d)`,
      "u",
    );
    if (!bindingRe.test(item)) {
      return false;
    }
  }
  return true;
}

function isAlgebraicClosingGroupBeforeSign(
  text: string,
  signIndex: number,
  operandEndIndex: number,
  mathRanges: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (isInsideMathRange(signIndex, mathRanges)) {
    return true;
  }
  let closeIndex = signIndex;
  while (closeIndex > 0 && /\s/.test(text[closeIndex - 1] ?? "")) closeIndex -= 1;
  closeIndex -= 1;
  const openIndex = findMatchingGroupOpen(text, closeIndex);
  if (openIndex === -1 || LINE_BREAK_RE.test(text.slice(openIndex, operandEndIndex))) {
    return false;
  }
  const inner = text.slice(openIndex + 1, closeIndex).trim();
  if (!inner) {
    return false;
  }
  const prefix = text.slice(findContextStart(text, openIndex, isClauseDelimiter), openIndex);
  const isMathCall = text[openIndex] === "(" && DIRECT_MATH_CALL_PREFIX_RE.test(prefix);
  const hasDirective = hasMathDirective(prefix);

  // Rule A (Prose/Option Label Veto): a parenthetical/bracketed modifier attached to a
  // non-math prose noun (Latin, CJK, or Unicode) is NEVER a binary-subtraction left operand,
  // regardless of any trailing relation (`=`, `≈`, `≡`, `<`, `>`).
  if (!hasDirective && !isMathCall && hasNonMathProseBeforeGroup(prefix)) {
    return false;
  }

  // Rule B (Physical/SI Compound Unit Group): only allow as an algebraic operand when
  // explicitly led by a math directive (English or CJK), preceded by a math operator,
  // or when all single-letter tokens in the group are explicitly bound as variables in text.
  const unitTokens = parsePhysicalUnitGroupTokens(inner);
  if (unitTokens !== null) {
    return (
      hasDirective ||
      MATH_OPERATOR_BEFORE_GROUP_RE.test(prefix) ||
      areGroupUnitTokensBoundInSentence(unitTokens, text, openIndex, operandEndIndex)
    );
  }

  // Rule C (Remaining non-unit algebraic groups)
  const { isPureAlgebraic, hasArithmeticOperator } = analyzeAlgebraicGroupInner(inner);
  return isPureAlgebraic && (
    hasArithmeticOperator ||
    isMathCall ||
    hasDirectClauseAlgebraicRelation(text, openIndex, operandEndIndex)
  );
}

function isBinaryLeftOperandBeforeSign(
  text: string,
  signIndex: number,
  operandEndIndex: number,
  mathRanges: ReadonlyArray<readonly [number, number]>,
): boolean {
  const before = text.slice(0, signIndex);
  if (DEFINITE_BINARY_LEFT_OPERAND_END_RE.test(before)) {
    return true;
  }
  if (CLOSING_GROUP_END_RE.test(before)) {
    return isAlgebraicClosingGroupBeforeSign(text, signIndex, operandEndIndex, mathRanges);
  }
  if (!AMBIGUOUS_PROSE_SINGLE_LETTER_END_RE.test(before)) {
    return false;
  }
  if (isInsideMathRange(signIndex, mathRanges)) {
    return true;
  }
  let varEnd = signIndex;
  while (varEnd > 0 && /\s/.test(text[varEnd - 1] ?? "")) varEnd -= 1;
  const varStart = Math.max(0, varEnd - 1);
  return hasDirectClauseAlgebraicRelation(text, varStart, operandEndIndex);
}

const SPACED_UNARY_SIGN_RE = new RegExp(
  `(?<=^|[(\\[{$,;:=<>!~]\\s*|\\p{Script=Han}\\s*|\\p{Script=Hiragana}\\s*|\\p{Script=Katakana}\\s*|\\p{Script=Hangul}\\s*|\\b(?:is|equals|expected|result|value|gives|be|are|to|of|at|around|about)\\s+)([+-])\\s+${MATH_OPERAND_LOOKAHEAD}`,
  "gimu",
);

const SPACED_UNICODE_MINUS_CANDIDATE_RE =
  /\u2212\s+(\d+(?:\.\d+)?|\.\d+|\u221A(?:\s*\([^)]*\)|\s*[a-z0-9]+)?|\p{Script=Greek}|sqrt\([^)]*\))/giu;

const SPACED_PROSE_ARTICLE_SIGN_RE = new RegExp(
  `(?<=(?:(?<![\\p{L}\\p{N}_])[aAiI]\\s+|[)\\]]\\s*))([+-])\\s+(\\d+(?:\\.\\d+)?|\\.\\d+|sqrt\\([^)]*\\)|(?:${GREEK_OR_CONST})\\b)`,
  "giu",
);

const SPACED_PLUS_MINUS_RE = new RegExp(`(\\+-|-\\+)\\s+${MATH_OPERAND_LOOKAHEAD}`, "gi");

function preserveSignLineBoundary(match: string, replacement: string, preserveLineBreaks: boolean): string {
  // When a sign was split from its operand by a line break, keep that boundary
  // before the signed token so the preceding line cannot supply a left operand.
  return preserveLineBreaks && LINE_BREAK_RE.test(match) ? `\n${replacement}` : replacement;
}

function collapseSpacedUnaryUnicodeMinus(text: string, preserveLineBreaks: boolean): string {
  const mathRanges = findMathRanges(text);
  return text.replace(
    SPACED_UNICODE_MINUS_CANDIDATE_RE,
    (match, operand: string, offset: number) => {
      if (isBinaryLeftOperandBeforeSign(text, offset, offset + match.length, mathRanges)) {
        return match;
      }
      return preserveSignLineBoundary(match, `-${operand}`, preserveLineBreaks);
    },
  );
}

function collapseSpacedProseArticleSigns(text: string, preserveLineBreaks: boolean): string {
  const mathRanges = findMathRanges(text);
  return text.replace(
    SPACED_PROSE_ARTICLE_SIGN_RE,
    (match, sign: string, operand: string, offset: number) => {
      if (isBinaryLeftOperandBeforeSign(text, offset, offset + match.length, mathRanges)) {
        return match;
      }
      return preserveSignLineBoundary(match, `${sign}${operand}`, preserveLineBreaks);
    },
  );
}

function normalizeMathSymbols(text: string, preserveMultiplication = false): string {
  text = text
    .replace(/\p{Script=Greek}/gu, symbol => {
      const lower = symbol.toLowerCase();
      return GREEK_SYMBOL_NAMES[GREEK_SYMBOLS.indexOf(GREEK_SYMBOL_VARIANTS.get(lower) ?? lower)] ?? symbol;
    })
    .replace(LATEX_GREEK_COMMAND_RE, (_match, name: string) =>
      GREEK_NAME_VARIANTS.get(name.toLowerCase()) ?? name.toLowerCase(),
    )
    .replace(ASCII_GREEK_VARIANT_RE, name => GREEK_NAME_VARIANTS.get(name.toLowerCase()) ?? name);
  for (const [pattern, replacement] of UNICODE_MATH_REPLACEMENTS) {
    if (preserveMultiplication && pattern === UNICODE_MULTIPLICATION_RE) continue;
    text = text.replace(pattern, replacement);
  }
  return text;
}

function normalizeOptionSyntax(syntax: string): string {
  // Keep multiplication glyphs from becoming Markdown delimiters during unwrapping.
  const mathSyntax = stripOptionMarkdown(normalizeMathSymbols(stripLatexNonOperandCommands(syntax, true), true))
    .replace(
      /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
      (span, inline: string | undefined, display: string, offset: number, text: string) =>
        preserveFormattedChoice(inline ?? display, text.slice(0, offset), text.slice(offset + span.length)),
    );
  return stripOptionMarkdown(stripOptionDollarMath(mathSyntax)).replace(UNICODE_MULTIPLICATION_RE, "*");
}

function preserveFormattedChoice(body: string, before: string, after: string): string {
  if (SINGLE_CHOICE_LETTER_RE.test(body.trim()) &&
    !(OPTION_WRAPPER_BEFORE_RE.test(before) && OPTION_WRAPPER_AFTER_RE.test(after))) {
    return "[" + body + "]";
  }
  return body;
}

function stripOptionDollarMath(text: string): string {
  const dollars = [...text.matchAll(/(?<![\\$])\${1,2}(?!\$)/g)];
  const parts: string[] = [];
  let copiedThrough = 0;
  for (let index = 1; index < dollars.length; index += 1) {
    const open = dollars[index - 1]!;
    const close = dollars[index]!;
    if (open[0] !== close[0]) continue;
    const end = close.index + close[0].length;
    const body = text.slice(open.index + open[0].length, close.index);
    if (!body.trim() || body.includes("$") || /^[$\p{L}\p{N}]/u.test(text.slice(end))) continue;
    if (open[0] === "$") {
      const amount = /^\s*(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)/.exec(body)?.[0];
      const rest = amount ? body.slice(amount.length) : "";
      // An amount followed by prose, punctuation or an incomplete math term
      // is a currency token. Leave the next dollar available as an opener.
      if (rest && (LINE_BREAK_RE.test(rest) ||
        /^(?:\s*$|[.,;:!?]|\s+[\p{L}\p{Ps}\p{Pi}])|[\p{Ps}\p{Pi}<"'*+/_^~=-]\s*$/u.test(rest))) {
        continue;
      }
    }
    const before = text.slice(copiedThrough, open.index);
    parts.push(before, preserveFormattedChoice(body, before, text.slice(end)));
    copiedThrough = end;
    index += 1;
  }
  return parts.length ? parts.join("") + text.slice(copiedThrough) : text;
}

function stripOptionMarkdown(text: string): string {
  const unwrapEmphasis = (span: string, _markers: string, body: string, offset: number, source: string): string =>
    preserveFormattedChoice(body, source.slice(0, offset), source.slice(offset + span.length));
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(/(?<![\\\p{L}\p{M}\p{N}*])(\*+)(?!\*)([^*\r\n]+)\1(?![\p{L}\p{M}\p{N}*])/gu, unwrapEmphasis)
      .replace(/(?<![\\\p{L}\p{M}\p{N}_])(_+)(?!_)([^_\r\n]+)\1(?![\p{L}\p{M}\p{N}_])/gu, unwrapEmphasis)
      .replace(/(?<![\\\p{L}\p{M}\p{N}~])(~+)(?!~)([^~\r\n]+)\1(?![\p{L}\p{M}\p{N}~])/gu, unwrapEmphasis)
      .replace(REDUNDANT_CHOICE_WRAPPER_RE, "$1$2")
      .replace(OPTION_WRAPPED_CODE_RE, "$1$3")
      // An unenclosed code span still acts as a choice wrapper.
      .replace(/(?<![\\\x60])(\x60{2,})(?!\x60)([^\x60]+)\1(?!\x60)/g, "\x60$2\x60");
  } while (text !== previous);
  return text;
}

function normalizeMathOperators(text: string): string {
  text = normalizeMathSymbols(text).trim().replace(/\s+/g, " ");
  // Collapse whitespace around math operators and parentheses in math expressions.
  text = text.replace(/\s*(<=|>=|!=|~=|==|=|<|>|\/|\*|\^)\s*/g, "$1");
  text = text.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  text = text.replace(/\bsqrt\s*\(\s*([^()]+?)\s*\)/gi, "sqrt($1)");
  return text;
}

function canonicalizeMathNotationPreserveCase(syntax: string, preserveLineBreaks = false): string {
  // Strip non-operand LaTeX before classifying signs. Unicode minus retains its
  // unary hint until this check, before it is converted to ASCII.
  let text = collapseSpacedUnaryUnicodeMinus(
    stripLatexNonOperandCommands(syntax),
    preserveLineBreaks,
  );
  text = preserveLineBreaks
    ? text.split(/\r\n?|[\n\u2028\u2029]/).map(normalizeMathOperators).join("\n")
    : normalizeMathOperators(text);
  for (const pattern of [SPACED_PLUS_MINUS_RE, SPACED_UNARY_SIGN_RE]) {
    text = text.replace(pattern, (match, sign: string) => (
      preserveSignLineBoundary(match, sign, preserveLineBreaks)
    ));
  }
  return collapseSpacedProseArticleSigns(text, preserveLineBreaks);
}

/**
 * Deterministically canonicalizes Unicode math notation (NFKC fractions/superscripts,
 * minus signs, Greek symbols, radicals, operators, comparisons, infinity) and collapses
 * whitespace inside math expressions (`π / 2` -> `pi/2`, `− 7` -> `-7`, `√ ( 2 )` -> `sqrt(2)`)
 * so leak checks match symmetrically across spaced, ASCII, Unicode, and CJK contexts.
 */
export function canonicalizeMathNotation(value: string): string {
  return canonicalizeMathNotationPreserveCase(normalizeLeakSyntax(value)).toLowerCase();
}

const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NON_CJK_WORD_CHAR =
  "(?:(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])[\\p{L}\\p{N}_])";
const NON_CJK_WORD_CHAR_RE = new RegExp(`^${NON_CJK_WORD_CHAR}$`, "u");

const ANSWER_CUE_NOUN = /(?:ans(?:wer)?|option|choice|key|selection|solutions?|result)/.source;
const ENGLISH_ANSWER_CUE =
  "(?:(?:correct|right|selected|marked|final|official)[_\\s-]*(?:" + ANSWER_CUE_NOUN + "|response|letter|value)" +
  "|(?:ans(?:wer)?|option|choice|solution|result|selection)[_\\s-]*key|" + ANSWER_CUE_NOUN + ")";
const BOUNDED_ANSWER_CUE = `(?:(?<!${NON_CJK_WORD_CHAR})${ENGLISH_ANSWER_CUE}(?!${NON_CJK_WORD_CHAR})|选|答案|正确选项)`;
const BARE_CHOICE_VERB = `(?<!${NON_CJK_WORD_CHAR})(?:correct|select|choose|pick)(?!${NON_CJK_WORD_CHAR})`;
const ANSWER_CUE_BEFORE_DASH_RE = new RegExp(`(?:${BOUNDED_ANSWER_CUE}|${BARE_CHOICE_VERB})\\s+$`, "iu");

const NUMERIC_TOKEN_END = `(?!${ALPHA_NUM_IDENT_CHAR}|\\.\\d|[eE][+-]?\\d)`;
const LOCALE_GROUPING_SPACES = "\u00A0\u2007\u2009\u202F";
const LOCALE_GROUPING_SPACE = new RegExp(`[${LOCALE_GROUPING_SPACES}]`, "gu");
const LOCALE_NON_GROUPING_RUN = new RegExp(`[^${LOCALE_GROUPING_SPACES}]+`, "gu");
const SPACE_GROUPED_INTEGER =
  `\\d{1,3}(?:${[...LOCALE_GROUPING_SPACES].map(space => `(?:${space}\\d{3})+`).join("|")})`;
const LOCALE_SPACE_GROUPED_DECIMAL = standaloneNumericSource(
  `(?<!\\d${LOCALE_GROUPING_SPACE.source})${SPACE_GROUPED_INTEGER}` +
  `(?!${LOCALE_GROUPING_SPACE.source}\\d)(?:,${DECIMAL_DIGITS}${OPTIONAL_DECIMAL_EXPONENT}(?!,\\d)|` +
  `(?:${DECIMAL_FRACTION})?${OPTIONAL_DECIMAL_EXPONENT})`,
);
const TUPLE_NUMBER = `(?:[+−-]\\s*)?(?:${UNGROUPED_DECIMAL}|` +
  `(?:${SPACE_GROUPED_INTEGER}|${APOSTROPHE_GROUPED_INTEGER})(?:${DECIMAL_FRACTION})?${OPTIONAL_DECIMAL_EXPONENT})`;
const NUMERIC_TUPLE_ITEM_RE = new RegExp(`^${TUPLE_NUMBER}$`, "u");
const DECIMAL_CONTAINER_CLOSER = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ["⟨", "⟩"], ["〈", "〉"]]);
// An angle opener is a tuple delimiter only when it encloses a numeric list.
const DECIMAL_CONTEXT_BRACKET_RE =
  /(?<!\\)(?:[()[\]{}⟨⟩〈〉>]|<(?=\s*[+−-]?(?:\d|\.\d)[\d.'_’eE\s+−-]*[,;]\s*[+−-]?(?:\d|\.\d)[\d.,;'_’eE\s+−-]*>))/gu;
const DECIMAL_CONTEXT_DELIMITER_RE = new RegExp(DECIMAL_CONTEXT_BRACKET_RE.source + "|[,;]", "gu");
const GROUPED_DECIMAL_OR_BRACKET_RE = new RegExp(
  DECIMAL_CONTEXT_BRACKET_RE.source + "|" + LOCALE_SPACE_GROUPED_DECIMAL + "|" + standaloneNumericSource(
    `(?:\\d{1,3}(?:\\.\\d{3})+|${APOSTROPHE_GROUPED_INTEGER}),${DECIMAL_DIGITS}${OPTIONAL_DECIMAL_EXPONENT}(?!,\\d)`,
  ),
  "gu",
);
// After an ellipsis, start at the digits rather than treating its final dot
// as the leading decimal point of a different value.
const UNGROUPED_DECIMAL_TOKEN = `(?!(?<=\\.)\\.)${UNGROUPED_DECIMAL}`;
const DECIMAL_TOKEN_SOURCE = standaloneNumericSource(
  `(?:${GROUPED_DECIMAL}|(?!${GROUPED_DECIMAL}${NUMERIC_TOKEN_END})${UNGROUPED_DECIMAL_TOKEN})`,
);
const COMMA_LIST_DECIMAL_TOKEN_SOURCE = standaloneNumericSource(UNGROUPED_DECIMAL_TOKEN);

function containsStandaloneNumericOrSymbolicToken(haystack: string, token: string): boolean {
  const decimalKey = canonicalDecimalValueKey(token);
  if (decimalKey !== null) {
    let mathRanges: ReturnType<typeof findMathRanges> | undefined;
    const pattern = new RegExp(DECIMAL_TOKEN_SOURCE, "gu");
    for (const match of haystack.matchAll(pattern)) {
      if (matchesDecimalValueAt(haystack, match[0], match.index, decimalKey, () => mathRanges ??= findMathRanges(haystack))) {
        return true;
      }
    }
    return false;
  }
  const source = standaloneNumericOrSymbolicSource(token);
  const excludeBinaryLeftOperand =
    /^[+-](?![+-])/.test(token) && STANDALONE_SIGNED_LITERAL_RE.test(token);
  if (!excludeBinaryLeftOperand) {
    return new RegExp(source, "iu").test(haystack);
  }
  const mathRanges = findMathRanges(haystack);
  const pattern = new RegExp(source, "giu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(haystack)) !== null) {
    if (!isBinaryLeftOperandBeforeSign(haystack, match.index, match.index + match[0].length, mathRanges)) {
      return true;
    }
  }
  return false;
}

function standaloneNumericOrSymbolicSource(token: string): string {
  const precededByDot = DECIMAL_LITERAL_RE.test(token) ? "(?<!\\.)\\." : "\\d\\.";
  return standaloneNumericSource(escapeRegExp(token), precededByDot);
}

function standaloneNumericSource(literalSource: string, precededByDot = "(?<!\\.)\\."): string {
  return `(?<!${ALPHA_NUM_IDENT_CHAR}|${precededByDot}|\\d[eE][+-]?)${literalSource}${NUMERIC_TOKEN_END}`;
}

function canonicalDecimalValueKey(literal: string): string | null {
  const parts = DECIMAL_VALUE_RE.exec(literal);
  if (!parts) return null;
  const [, sign, integer = "", rawFraction = "", exponent = "0"] = parts;
  const fraction = rawFraction.replaceAll("_", "");
  const digits = integer.replace(/[_,’']/g, "") + fraction;
  if (!digits) return null;
  const significant = digits.replace(/^0+/, "");
  if (!significant) return "0";
  const trimmed = significant.replace(/0+$/, "");
  // The exponent records the position of the first significant digit. It
  // remains exact without expanding the decimal or converting its digits.
  const scientificExponent = BigInt(exponent.replaceAll("_", "")) + BigInt(significant.length - fraction.length - 1);
  return `${sign === "-" ? "-" : "+"}:${trimmed}:e${scientificExponent}`;
}

function matchesDecimalValueAt(
  text: string,
  magnitude: string,
  start: number,
  expectedKey: string,
  getMathRanges: () => ReturnType<typeof findMathRanges>,
): boolean {
  const unsignedKey = canonicalDecimalValueKey(magnitude);
  if (unsignedKey === null) return false;
  if (unsignedKey === "0") return expectedKey === unsignedKey;
  const negativeKey = "-" + unsignedKey.slice(1);
  if (expectedKey !== unsignedKey && expectedKey !== negativeKey) return false;

  const end = start + magnitude.length;
  const prefix = /([+-]{1,2})([^\S\r\n\u2028\u2029]*(?:\([^\S\r\n\u2028\u2029]*)*)$/u.exec(text.slice(0, start));
  if (!prefix) return expectedKey === unsignedKey;

  const openGroups = prefix[2]?.match(/\(/g)?.length ?? 0;
  if (openGroups > 0) {
    const closingGroups = /^(?:[^\S\r\n\u2028\u2029]*\))*/u.exec(text.slice(end));
    const closeCount = closingGroups?.[0].match(/\)/g)?.length ?? 0;
    if (openGroups > closeCount) return expectedKey === unsignedKey;
  }
  if (isBinaryLeftOperandBeforeSign(text, prefix.index, end, getMathRanges())) {
    return expectedKey === unsignedKey;
  }

  if (prefix[1] === "+") return expectedKey === unsignedKey;
  if (prefix[1] !== "-") return false;
  // Between an answer label and a value, a spaced dash can be punctuation
  // or a unary sign. Protect both interpretations.
  return expectedKey === negativeKey ||
    (/\s/.test(prefix[2]?.[0] ?? "") && ANSWER_CUE_BEFORE_DASH_RE.test(text.slice(0, prefix.index)));
}

function containsUnicodeWordBoundedToken(haystack: string, token: string): boolean {
  const escaped = escapeRegExp(token);
  const pattern = new RegExp(
    `(?<!${NON_CJK_WORD_CHAR})${escaped}(?!${NON_CJK_WORD_CHAR})`,
    "iu",
  );
  return pattern.test(haystack);
}

function containsCjkBoundedSubstring(haystack: string, needle: string): boolean {
  const chars = [...needle];
  const firstChar = chars[0];
  const lastChar = chars[chars.length - 1];
  if (!firstChar || !lastChar) return false;
  const needsLeadingBoundary = NON_CJK_WORD_CHAR_RE.test(firstChar);
  const needsTrailingBoundary = NON_CJK_WORD_CHAR_RE.test(lastChar);
  if (!needsLeadingBoundary && !needsTrailingBoundary) {
    return haystack.includes(needle);
  }
  const escaped = escapeRegExp(needle);
  const prefix = needsLeadingBoundary ? `(?<!${NON_CJK_WORD_CHAR})` : "";
  const suffix = needsTrailingBoundary ? `(?!${NON_CJK_WORD_CHAR})` : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "iu").test(haystack);
}

const OPTION_WRAPPER_OPEN = /[\p{Pi}\p{Ps}\p{Quotation_Mark}<`]/u.source;
const OPTION_WRAPPER_CLOSE = /[\p{Pf}\p{Pe}\p{Quotation_Mark}>`]/u.source;
const UNSIGNED_OPTION_SCALAR = `(?:${UNSIGNED_DECIMAL_LITERAL}|${GREEK_OR_CONST})`;
const UNSIGNED_OPTION_SCALAR_RE = new RegExp(`^${UNSIGNED_OPTION_SCALAR}$`, "iu");
const WRAPPED_OPTION_LABEL_RE = new RegExp(
  `^${OPTION_WRAPPER_OPEN}\\s*([a-z]|${UNSIGNED_OPTION_SCALAR})\\s*${OPTION_WRAPPER_CLOSE}$`,
  "iu",
);
const OPTION_WORD_CONNECTOR = /\b(?:and|or|then)\b/.source;
const OPTION_END_PUNCTUATION = /[\s.!?。！？;；:：,，、…—–-]*/u.source;
const OPTION_WRAPPER_BEFORE_RE = new RegExp(OPTION_WRAPPER_OPEN + "\\s*$", "u");
const OPTION_WRAPPER_AFTER_RE = new RegExp("^" + OPTION_END_PUNCTUATION + OPTION_WRAPPER_CLOSE, "u");
const REDUNDANT_CHOICE_WRAPPER_RE = new RegExp(
  "(" + OPTION_WRAPPER_OPEN + "\\s*)\\[(\\s*[a-z]\\s*)\\](?=" + OPTION_END_PUNCTUATION + OPTION_WRAPPER_CLOSE + ")",
  "giu",
);
const OPTION_WRAPPED_CODE_RE = new RegExp(
  "(" + OPTION_WRAPPER_OPEN + "\\s*)(?<!\\x60)(\\x60+)(?!\\x60)" +
  "((?:(?!(?<!\\x60)\\2(?!\\x60))[\\s\\S])+)(?<!\\x60)\\2(?!\\x60)" +
  "(?=" + OPTION_END_PUNCTUATION + OPTION_WRAPPER_CLOSE + ")",
  "gu",
);
const OPTION_CLOSING = `${OPTION_END_PUNCTUATION}${OPTION_WRAPPER_CLOSE}`;
const OPTION_SENTENCE_TERMINATOR_RE = /[.!?。！？;；]/u;
const OPTION_SENTENCE_BOUNDARY = `(?:\\s|$|${CJK_SCRIPT_RE.source})`;
const OPTION_SENTENCE_END =
  `${OPTION_END_PUNCTUATION}(?:${OPTION_SENTENCE_TERMINATOR_RE.source}(?=${OPTION_SENTENCE_BOUNDARY})|$)`;
const END_AFTER_OPTION_RE = new RegExp(`^${OPTION_SENTENCE_END}`, "u");
const BOUNDARY_AFTER_QUOTED_END_RE = new RegExp(`^${OPTION_SENTENCE_BOUNDARY}`, "u");
const OPTION_SEQUENCE_CONNECTOR =
  `\\s*` +
  `(?:[,，、](?:\\s*${OPTION_WORD_CONNECTOR})?|[;/÷∕⁄&+→]|[-−–—‐‑=]\\s*>|${OPTION_WORD_CONNECTOR})\\s*`;
const OPTION_SEQUENCE_SEPARATOR =
  `(?:${OPTION_CLOSING})?${OPTION_SEQUENCE_CONNECTOR}(?:${OPTION_WRAPPER_OPEN}\\s*)?`;
const OPTION_WORD_CHAR = /[\p{L}\p{N}_]/u.source;
const OPTION_WORD_CONTINUATION = `(?:${OPTION_WORD_CHAR}|['’]${OPTION_WORD_CHAR})`;
const WRAPPED_NEIGHBOR_OPTION =
  `${OPTION_WRAPPER_OPEN}\\s*[a-z]${OPTION_CLOSING}(?!${OPTION_WORD_CONTINUATION})`;
const BARE_NEIGHBOR_OPTION =
  `(?<!${NON_CJK_WORD_CHAR}|${OPTION_WRAPPER_OPEN}\\s*)[a-z](?!${OPTION_WORD_CONTINUATION}|${OPTION_WRAPPER_CLOSE})`;
const PRECEDING_OPTION_RE = new RegExp(
  `(?:${WRAPPED_NEIGHBOR_OPTION}|${BARE_NEIGHBOR_OPTION})${OPTION_SEQUENCE_CONNECTOR}$`,
  "iu",
);
const NEXT_OPTION_RE = new RegExp(
  `^${OPTION_SEQUENCE_CONNECTOR}(?:${WRAPPED_NEIGHBOR_OPTION}|${BARE_NEIGHBOR_OPTION}(?=${OPTION_SENTENCE_END}))`,
  "iu",
);
const ARTICLE_STOP_WORD_RE = new RegExp("^(?:" +
  "for|in|on|at|to|of|by|with|from|into|onto|upon|over|under|after|before|between|among|through|during|" +
  "without|within|about|against|per|via|as|up|off|out|across|along|past|around|inside|outside|despite|except|towards?|" +
  "like|unlike|besides|beside|beyond|behind|above|below|beneath|amid|amidst|amongst|throughout|concerning|regarding|" +
  "including|excluding|following|barring|pending|worth|assuming|supposing|considering|granted|seeing|" +
  "is|was|are|were|be|been|being|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must|equals?|" +
  "and|or|but|nor|yet|so|if|then|else|when|while|where|whereas|because|since|unless|until|till|although|though|than|whether|" +
  "that|which|who|whom|whose|what|i|he|him|his|she|her|hers|it|its|we|us|our|ours|you|your|yours|they|them|their|theirs|" +
  "myself|yourself|himself|herself|itself|ourselves|yourselves|themselves|" +
  "me|my|mine|this|these|those|the|an|another|each|every|all|both|any|either|neither|some|several|many|much|no|none|" +
  "instead|apart|aside|away|regardless|irrespective|only|alone|already|" +
  "also|too|again|once|twice|here|there|now|today|tomorrow|yesterday|tonight|otherwise|therefore|however|thus|hence|" +
  "whenever|wherever|whatever|whichever|whoever|whomever|moreover|furthermore|nevertheless|nonetheless|meanwhile|" +
  "henceforth|thereafter|thereby|therein|thereof|whereby|wherein|whereof|lest|albeit|" +
  "just|even|not|never|always|often|sometimes|usually|ever|seldom|rarely|hardly|barely|scarcely|same|such|" +
  "versus|vs|plus|minus|modulo|mod|times)$");
const ARTICLE_MODIFIER_WORD_RE = new RegExp("^(?:" +
  "zeroth|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|" +
  "[a-z]+(?:teenth|tieth|illionth)|hundredth|thousandth|next|last|[a-z]+ly|almost|pairwise|" +
  "right|left|single|double|triple|fast|hard|early|late|soon|far|near|close|very|quite|pretty|rather|well|ill|more|less|most|least|" +
  "still|given|provided)$");
const ARTICLE_LY_NOUN_RE =
  /^(?:family|anomaly|assembly|monopoly|supply|reply|ally|tally|rally|valley|pulley|belly|jelly|lily|(?:butter|dragon|fire|may)?fly|bully|folly|gully|holly)$/;
const ARTICLE_QUANTITY_TOKEN = /\d(?:[^\s.,;:!?()[\]{}<>]|\.(?=\d))*/u.source;
const ARTICLE_CARDINAL_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|" +
  "thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|" +
  "eighty|ninety|hundred|thousand|million|billion|trillion|quadrillion|quintillion";
const ARTICLE_CARDINAL_RE = new RegExp(`^(?:${DECIMAL_DIGITS}|${ARTICLE_CARDINAL_WORD})$`);
const ARTICLE_CARDINAL_ADJUNCT_RE = /^[ \t]+(?:more|less|last|other|another|by|at|of|or|and|times)\b/i;
const ARTICLE_DIMENSION = `(?:${ARTICLE_QUANTITY_TOKEN}|${ARTICLE_CARDINAL_WORD}|[a-z])`;
const ARTICLE_DIMENSION_SEPARATOR = /(?:[ \t]+(?:by|[x×*])[ \t]+|-by-)/.source;
const ARTICLE_DIMENSION_TOKEN =
  `${ARTICLE_DIMENSION}(?:${ARTICLE_DIMENSION_SEPARATOR}${ARTICLE_DIMENSION})+(?![\\w-])`;
const ARTICLE_REPETITION_NOUN_RE = /^(?:times?|way|turn|round|try|chance)$/;
const ARTICLE_SINGULAR_S_RE =
  /(?:[sui]s|ics|^(?:series|species|lens|canvas|atlas|bias|gas|bus|alias|news|means|corps|chaos|cosmos|pathos|ethos|thermos|asbestos))$/;
const ARTICLE_IRREGULAR_PLURAL_RE = /^(?:children|people|men|women|teeth|feet|mice|geese|criteria|phenomena)$/;
// Option normalization spells Greek unit symbols as "mu" and "omega".
const ARTICLE_MEASUREMENT_UNIT =
  /(?:(?:da|mu|[dcmunpfkgtμµ])?(?:pa|hz|ev|mol|ohm|bar|wh|ah|va|lm|lx|bq|gy|sv|wb|omega|[gmsavwjncfhlbktΩω])|atm|psi|cal|kcal|rpm|mph|kph|[kmg]?bps|db|rad|deg|sr|px|pt|em|rem|ft|yd|mi|oz|lb|gal|°[cf]?|[%ÅåÅ])(?:\^?[+-]?\d+)?/u.source;
const ARTICLE_MEASUREMENT_TOKEN =
  `${UNGROUPED_DECIMAL}[ \\t]*${ARTICLE_MEASUREMENT_UNIT}(?:[ \\t]*/[ \\t]*${ARTICLE_MEASUREMENT_UNIT})*(?![\\w/%°^])`;

const ARTICLE_MEASURE_WORD_RE = new RegExp(
  `^(?:${ARTICLE_MEASUREMENT_UNIT}|dimensional|sided|step|phase|stage|cycle|point|part|digit|bit|byte|page|` +
  "unit|term|factor|second|minute|hour|day|week|month|year|inch|foot|yard|mile|met(?:er|re)|" +
  "(?:centi|milli|kilo)met(?:er|re)|gram|kilogram|milligram|pound|ounce|tonne?|lit(?:er|re)|gallon|degree)$",
);
// A word like "flat" can complete a noun phrase before a finite verb.
const ARTICLE_PRENOMINAL_ADJECTIVE_RE = new RegExp("^(?:" +
  "new|old|small|large|simple|complex|steep|horizontal|orthogonal|collinear|coplanar|nonzero|" +
  "linear|nonlinear|planar|angular|rectangular|triangular|diagonal|spatial|temporal|directional|translational|rotational|" +
  "straight|smooth|acute|obtuse|convex|concave|finite|infinite|discrete|strict|weak|strong|" +
  "[a-z]+(?:able|ible|ical|ive|ous|less|ful|ish|ary))$");
const ARTICLE_COLOR_RE = /^(?:red|blue|green)$/;

const ARTICLE_CLAUSE_END_RE = /[.!?。！？;；:：\r\n\u2028\u2029]/u;
const ARTICLE_SUBORDINATE_RE = /^(?:that|which|who|whom|whose|where|when|while|if|unless|because|since|although|though|whether)$/;
const ARTICLE_ARITHMETIC_RE = /[+\-*/^|]/u;
const ARTICLE_CLAUSE_TOKEN_RE = new RegExp(
  `${RELATION_OP_RE.source}|${UNGROUPED_DECIMAL}|[\\p{L}_][\\p{L}\\p{M}\\p{N}_]*(?:-[\\p{L}\\p{M}\\p{N}_]+)*|` +
  `${/[()[\]{},，]/u.source}|${ARTICLE_CLAUSE_END_RE.source}|${ARTICLE_ARITHMETIC_RE.source}`,
  "gu",
);
const ARTICLE_RELATION_COMPLEMENT_RE = /^(?:in|on|at|with|for|from|over|under|within|between|among|through|near|around|across|along|into|onto)$/;
const ARTICLE_IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const ARTICLE_SYMBOLIC_TERM = `(?:\\d+)?(?:\\p{L}|${GREEK_OR_CONST})(?:\\d+|_[\\p{L}\\p{N}]+)?`;
const ARTICLE_SYMBOLIC_LHS_RE = new RegExp(
  `^${ARTICLE_SYMBOLIC_TERM}(?:-(?:${ARTICLE_SYMBOLIC_TERM}|${UNGROUPED_DECIMAL}))*$`,
  "u",
);
const ARTICLE_MATH_FUNCTION_RE = new RegExp("^(?:" + MATH_FUNCTION_NAMES.join("|") + "|" +
  "cbrt|sec|csc|cot|arcsin|arccos|arctan|arccot|arcsec|arccsc|asin|acos|atan|" +
  "sinh|cosh|tanh|coth|sech|csch|asinh|acosh|atanh|lg|lim|limsup|liminf|sup|inf|" +
  "det|tr|trace|rank|dim|ker|im|re|deg|gcd|lcm|mod|arg|sgn|sign|floor|ceil|round|norm|proj|span|grad|div|curl)" +
  "(?:_[\\p{L}\\p{N}]+)?$", "u");
const ARTICLE_DETERMINER_RE = /^(?:the|a|an|this|these|those|each|every|all|both|any|some|no|its|their|our|your|my|his|her)$/;
const ARTICLE_PARTICIPLE_COMPLEMENT_RE = /^(?:in|on|by|from|with|to|for|at|as|under|over|into|through)$/;
const ARTICLE_PARTICIPLE_DIRECTION_RE = /^(?:counter|anti)?clockwise$/;
const ARTICLE_FINITE_AUXILIARY_RE = /^(?:is|are|was|were|am|be|been|being|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must)$/;
const ARTICLE_INFINITIVE_CHAIN_RE = /^(?:be|have|been|being)$/;
const ARTICLE_FINITE_VERB_RE = new RegExp("^(?:" +
  "fails|converges|diverges|vanishes|exceeds|implies|satisfies|violates|occurs|appears|exists|becomes|differs|" +
  "succeeds|commutes|terminates|contradicts|guarantees|ensures|tends|rotates|fluctuates|oscillates|trembles|seems|" +
  "stabilizes|maximizes|minimizes|solves|obeys|governs|describes|represents|denotes|assumes)$");
const ARTICLE_HOMOGRAPH_VERB_RE = new RegExp("^(?:" +
  "holds|equals|remains|stays|works|means|states|shows|gives|yields|makes|takes|uses|needs|lacks|contains|" +
  "includes|excludes|requires|matches|applies|follows|depends|lies|falls|rises|grows|decays|reduces|simplifies|" +
  "cancels|persists|forces|determines|reaches|attains|intersects|crosses|starts|begins|ends|stops|continues|produces|returns|" +
  "approaches|touches|passes|meets|moves|shifts|scales|maps|projects|transforms|increases|decreases|doubles|halves|peaks|drops|jumps|hits)$");
const ARTICLE_INTRANSITIVE_PAST_RE = new RegExp("^(?:" +
  "failed|converged|diverged|vanished|occurred|appeared|existed|remained|stayed|persisted|worked|held|fell|rose|" +
  "grew|decayed|began|ended|stopped|became|differed|succeeded|commuted|terminated|depended|lay|continued|" +
  "tended|peaked|jumped|fluctuated|oscillated|trembled|seemed)$");
const ARTICLE_TRANSITIVE_PAST_RE = new RegExp("^(?:" +
  "exceeded|implied|satisfied|violated|contradicted|guaranteed|ensured|equaled|meant|stated|showed|gave|yielded|" +
  "made|took|used|needed|lacked|contained|included|excluded|required|matched|applied|followed|reduced|simplified|" +
  "cancelled|forced|determined|reached|attained|intersected|crossed|started|produced|returned|computed|defined|measured|tested|" +
  "approached|touched|passed|met|moved|shifted|scaled|rotated|mapped|projected|transformed|increased|decreased|" +
  "doubled|halved|dropped|stabilized|maximized|minimized|solved|obeyed|governed|described|" +
  "represented|denoted|assumed|hit)$");
const ARTICLE_PARTICIPLE_FORM_RE = /^(?:[a-z]{2,}(?:ed|ing)|shown|given|taken|known|written|drawn|seen)$/;
const ARTICLE_PLURAL_VERB_RE = new RegExp("^(?:" +
  "fail|hold|equal|vanish|converge|diverge|commute|differ|match|satisfy|violate|exist|work|remain|stay|appear|occur|apply|follow|depend|" +
  "approach|tend|touch|pass|meet|move|shift|scale|rotate|map|project|transform|intersect|increase|decrease|double|halve|peak|drop|jump|" +
  "fluctuate|oscillate|tremble|seem|stabilize|maximize|minimize|solve|obey|govern|describe|represent|denote|assume|hit)$");
const ARTICLE_IMPERATIVE_RE = /^(?:compute|find|show|prove|check|explain|determine|evaluate|verify|state|give|write|list|sketch|plot)$/;
const ARTICLE_ED_NOUN_RE = /^(?:speed|seed|feed|need|weed|reed|bed|sled|shed|shred|thread|bread|head|lead|spread|tread|stead|med|ped|biped|quadruped|hundred)$/;
const ARTICLE_APPOSITIVE_NOUN_HOMOGRAPH_RE = /^(?:approach|touch|pass|meet|move|shift|scale|map|project|transform|increase|decrease|peak|drop|jump|hit)$/;
const ARTICLE_NOUN_COMPOUND_RE = /^(?:mountain passes|coordinate transforms)$/;

const ARTICLE_IMPLICIT_PRODUCT_RE = /^\d*([a-z]{2,3})(?:_[\p{L}\p{N}]+)?$/iu;
const ARTICLE_TWO_LETTER_PROSE_RE = /^(?:in|on|at|to|of|by|as|up|or|if|so|no|an|is|am|be|do|go|we|he|me|my|us|it|ox)$/;
const ARTICLE_THREE_LETTER_PROSE_RE = new RegExp("^(?:" +
  "act|add|age|aid|aim|air|arm|art|ash|bag|bar|bat|bed|bet|big|bit|bow|box|boy|bus|buy|cab|can|cap|car|cat|cow|" +
  "cup|cut|day|den|dew|did|dog|dot|dry|due|dye|ear|eat|egg|end|era|eye|fan|far|fat|fee|few|fit|fix|fly|fog|fun|" +
  "gap|gas|get|got|gun|gut|guy|had|hat|hay|hen|her|hid|hip|his|hit|hot|how|ice|icy|ink|ion|jam|jar|jaw|jet|job|" +
  "joy|key|kid|kit|lab|lag|lap|law|lay|led|leg|let|lid|lie|lip|lit|log|lot|low|mad|man|map|mat|max|may|met|min|" +
  "mix|mob|mop|mud|mug|nap|net|new|nod|nor|not|now|nut|odd|off|oil|old|one|opt|ore|out|owe|own|pad|pan|pat|paw|" +
  "pay|pea|pen|pet|pie|pig|pin|pit|pop|pot|pro|put|rag|ran|rap|rat|raw|ray|red|rib|rid|rip|rob|rod|rot|row|rub|" +
  "rug|run|rye|sad|sap|sat|saw|say|sea|see|set|sew|she|shy|sin|sip|sir|sit|six|ski|sky|sly|sob|son|spa|spy|sub|" +
  "sue|sum|sun|tab|tag|tan|tap|tar|tax|tea|tee|ten|the|tie|tin|tip|toe|ton|too|top|tow|toy|try|tub|two|use|van|" +
  "vet|via|war|was|wax|way|web|wed|wet|who|why|wig|win|wit|won|wow|yam|yes|yet|you|zip|zoo|all|bad)$");
const ARTICLE_PRODUCT_OPERATOR_RE = /^[+\-*/^]$/;

function isArticleFinitePredicateWord(word: string): boolean {
  return ARTICLE_FINITE_AUXILIARY_RE.test(word) || ARTICLE_FINITE_VERB_RE.test(word) || ARTICLE_HOMOGRAPH_VERB_RE.test(word) ||
    ARTICLE_INTRANSITIVE_PAST_RE.test(word) || ARTICLE_TRANSITIVE_PAST_RE.test(word);
}

function isArticleRelationBoundaryWord(word: string): boolean {
  return ARTICLE_STOP_WORD_RE.test(word) || ARTICLE_DETERMINER_RE.test(word) || ARTICLE_SUBORDINATE_RE.test(word) ||
    isArticleFinitePredicateWord(word) || ARTICLE_PLURAL_VERB_RE.test(word);
}

function isArticleImplicitProduct(token: string, nearArithmetic: boolean): boolean {
  return token.split("-").every(term => {
    const lowerTerm = term.toLowerCase();
    if (ARTICLE_SYMBOLIC_LHS_RE.test(lowerTerm) || DECIMAL_LITERAL_RE.test(lowerTerm)) return true;
    if (ARTICLE_IDENTIFIER_RE.test(term) && /\p{Lu}/u.test(term.slice(1)) && !isArticleRelationBoundaryWord(lowerTerm)) {
      return true;
    }
    const variables = ARTICLE_IMPLICIT_PRODUCT_RE.exec(term)?.[1];
    if (variables === undefined) return false;
    const word = variables.toLowerCase();
    // "by" is b times y when an explicit arithmetic operator connects the terms.
    if (word === "by") return nearArithmetic;
    if (isArticleRelationBoundaryWord(word)) return false;
    return /[A-Z]/.test(variables.slice(1)) ||
      !(ARTICLE_TWO_LETTER_PROSE_RE.test(word) || ARTICLE_THREE_LETTER_PROSE_RE.test(word));
  });
}

function isArticlePrepositionalBoundary(word: string): boolean {
  return isArticleRelationBoundaryWord(word) || ARTICLE_RELATION_COMPLEMENT_RE.test(word) ||
    ARTICLE_PARTICIPLE_COMPLEMENT_RE.test(word) || ARTICLE_IMPERATIVE_RE.test(word) ||
    (word.endsWith("ly") && word !== "early" && !ARTICLE_LY_NOUN_RE.test(word));
}

function articleClauseTokens(remainder: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  for (const [token] of remainder.matchAll(ARTICLE_CLAUSE_TOKEN_RE)) {
    if ("([{".includes(token)) {
      // Keep one token for the entire group, including function arguments.
      if (depth === 0) tokens.push(token);
      depth += 1;
    } else if (")]}".includes(token)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (token.length === 1 && ARTICLE_CLAUSE_END_RE.test(token)) break;
      tokens.push(token === "，" ? "," : token);
    }
  }
  return tokens;
}

function articleFunctionArgumentStart(tokens: readonly string[], index: number): number | undefined {
  const name = tokens[index]!.toLowerCase();
  let argumentStart = index + 1;
  if (tokens[argumentStart] === "(" && ARTICLE_IDENTIFIER_RE.test(name)) return argumentStart;
  if (!ARTICLE_MATH_FUNCTION_RE.test(name)) return undefined;

  if (tokens[argumentStart] === "^") {
    argumentStart += 1;
    if (tokens[argumentStart] === "+" || tokens[argumentStart] === "-") argumentStart += 1;
    const exponent = tokens[argumentStart] ?? "";
    if (exponent !== "(" && !isArticleImplicitProduct(exponent, true)) return undefined;
    argumentStart += 1;
  }

  const argument = tokens[argumentStart] ?? "";
  return argument === "(" || isArticleImplicitProduct(argument, false) ? argumentStart : undefined;
}

function articleRelationComplementEnd(tokens: readonly string[], start: number): number {
  let expectsOperand = true;
  let sawRelation = false;
  let insideAbsoluteValue = false;
  let end = start;
  for (let index = start; index < tokens.length; index += 1) {
    const rawToken = tokens[index]!;
    const token = rawToken.toLowerCase();
    const argument = tokens[index + 1]?.toLowerCase() ?? "";
    if (RELATION_OP_RE.test(token)) {
      if (expectsOperand || insideAbsoluteValue) break;
      sawRelation = true;
      expectsOperand = true;
      continue;
    }
    if (token === "|") {
      if (expectsOperand === insideAbsoluteValue) break;
      insideAbsoluteValue = !insideAbsoluteValue;
    } else if (token.length === 1 && ARTICLE_ARITHMETIC_RE.test(token)) {
      if (expectsOperand && token !== "+" && token !== "-") break;
      expectsOperand = true;
    } else {
      const argumentStart = articleFunctionArgumentStart(tokens, index);
      if (argumentStart !== undefined) {
        // A verb following a complete RHS can introduce a parenthetical aside.
        if (sawRelation && !expectsOperand && isArticleFinitePredicateWord(token)) break;
        index = argumentStart - 1;
        expectsOperand = true;
      } else if ("([{".includes(token) || isArticleImplicitProduct(rawToken,
        ARTICLE_PRODUCT_OPERATOR_RE.test(tokens[index - 1] ?? "") || ARTICLE_PRODUCT_OPERATOR_RE.test(argument))) {
        expectsOperand = false;
      } else {
        break;
      }
    }
    // Keep the last complete comparison, including any chained relation.
    if (sawRelation && !expectsOperand && !insideAbsoluteValue) end = index + 1;
  }
  return end;
}

function articlePrepositionalRelationEnd(tokens: readonly string[], start: number): number {
  const directEnd = articleRelationComplementEnd(tokens, start);
  if (directEnd > start) return directEnd;

  const headStart = ARTICLE_DETERMINER_RE.test(tokens[start]?.toLowerCase() ?? "") ? start + 1 : start;
  for (let headIndex = headStart; headIndex < headStart + 3; headIndex += 1) {
    const word = tokens[headIndex]?.toLowerCase() ?? "";
    if (!ARTICLE_IDENTIFIER_RE.test(word) ||
      (isArticlePrepositionalBoundary(word) && !ARTICLE_APPOSITIVE_NOUN_HOMOGRAPH_RE.test(word))) break;

    // The appositive needs its own LHS, as in "the straight line x + y = 1".
    const appositiveStart = headIndex + 1;
    const first = tokens[appositiveStart]?.toLowerCase() ?? "";
    if (isArticlePrepositionalBoundary(first) && !ARTICLE_APPOSITIVE_NOUN_HOMOGRAPH_RE.test(first)) break;
    const end = articleRelationComplementEnd(tokens, appositiveStart);
    if (end > appositiveStart) {
      // A later head must be singular and cannot be a predicate after the noun.
      const plural = word.endsWith("s") && !ARTICLE_SINGULAR_S_RE.test(word);
      const pastVerb = /[aeiouy][a-z]*ed$/.test(word) && !ARTICLE_ED_NOUN_RE.test(word);
      return headIndex > headStart && (plural || pastVerb) ? start : end;
    }
  }

  return start;
}

function isArticleMannerAdverb(word: string): boolean {
  return word.endsWith("ly") && word !== "only" && word !== "early" && !ARTICLE_LY_NOUN_RE.test(word);
}

function hasConditionalClausePredicate(remainder: string): boolean {
  const tokens = articleClauseTokens(remainder);
  let previous = "";
  let expectsNoun = false;
  let expectsPluralHead = false;
  let afterQuantifiedPluralHead = false;
  let inInfinitive = false;
  let hasConjoinedSubject = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.toLowerCase();
    if (token === ",") {
      const closingComma = tokens.indexOf(",", index + 2);
      if (closingComma < 0) break;
      // Resume the main clause after the aside rather than scanning its verbs.
      index = closingComma;
      expectsPluralHead = false;
      continue;
    }
    if (ARTICLE_SUBORDINATE_RE.test(token)) break;
    const afterConjunction = previous === "and" || previous === "or";
    if (afterConjunction && ARTICLE_IMPERATIVE_RE.test(token)) break;
    hasConjoinedSubject ||= afterConjunction;

    const relationComplement = ARTICLE_RELATION_COMPLEMENT_RE.test(token);
    if (relationComplement) {
      const end = articlePrepositionalRelationEnd(tokens, index + 1);
      if (end > index + 1) {
        index = end - 1;
        previous = "";
        expectsNoun = false;
        expectsPluralHead = false;
        afterQuantifiedPluralHead = false;
        inInfinitive = false;
        continue;
      }
    }
    if (RELATION_OP_RE.test(token)) return true;

    const next = tokens[index + 1]?.toLowerCase() ?? "";
    const determiner = ARTICLE_DETERMINER_RE.test(token);
    if (expectsPluralHead && (determiner || relationComplement || ARTICLE_STOP_WORD_RE.test(token))) {
      expectsPluralHead = false;
    }
    const participle = ARTICLE_PARTICIPLE_FORM_RE.test(token) && !ARTICLE_ED_NOUN_RE.test(token);
    const infinitiveAuxiliary = ARTICLE_INFINITIVE_CHAIN_RE.test(token);
    const nounSlot: boolean = afterConjunction || expectsNoun || expectsPluralHead ||
      previous === "of" || previous === "by" || ARTICLE_RELATION_COMPLEMENT_RE.test(previous);
    if (ARTICLE_FINITE_AUXILIARY_RE.test(token) &&
      !(inInfinitive && (infinitiveAuxiliary || token === "do"))) return true;
    if (ARTICLE_FINITE_VERB_RE.test(token)) return true;
    if (!nounSlot) {
      if (ARTICLE_HOMOGRAPH_VERB_RE.test(token) ||
        ((hasConjoinedSubject || afterQuantifiedPluralHead) && ARTICLE_PLURAL_VERB_RE.test(token))) {
        return true;
      }
      if (!inInfinitive) {
        if (ARTICLE_INTRANSITIVE_PAST_RE.test(token)) return true;
        if (ARTICLE_TRANSITIVE_PAST_RE.test(token)) {
          const complement = next.endsWith("ly") ? tokens[index + 2]?.toLowerCase() ?? "" : next;
          if (!ARTICLE_PARTICIPLE_COMPLEMENT_RE.test(complement) &&
            !ARTICLE_PARTICIPLE_DIRECTION_RE.test(complement)) return true;
        }
      }
    }

    // A number opens a noun slot after "among the", but is a label in "theorem 1".
    const quantity = ARTICLE_CARDINAL_RE.test(token) || DECIMAL_LITERAL_RE.test(token);
    // A plural quantity can span a noun used as a modifier, as in "two speed increases".
    const pluralHead: boolean = expectsPluralHead &&
      ((token.endsWith("s") && !ARTICLE_SINGULAR_S_RE.test(token)) || ARTICLE_IRREGULAR_PLURAL_RE.test(token));
    afterQuantifiedPluralHead = pluralHead || (afterQuantifiedPluralHead && isArticleMannerAdverb(token));
    expectsPluralHead = (expectsPluralHead && !pluralHead) ||
      (nounSlot && quantity && token !== "one" && token !== "1" && next !== "of");
    const colorModifier = ARTICLE_COLOR_RE.test(token) &&
      (previous !== "the" || (token === "red" && tokens[index - 2]?.toLowerCase() !== "in"));
    // "The diagonal" and "a straight" can be complete countable noun phrases.
    const prenominalAdjective = ARTICLE_PRENOMINAL_ADJECTIVE_RE.test(token) &&
      !((token === "diagonal" || token === "straight") && ARTICLE_DETERMINER_RE.test(previous));
    expectsNoun = determiner ||
      (nounSlot && (quantity || participle ||
        prenominalAdjective || colorModifier ||
        ARTICLE_NOUN_COMPOUND_RE.test(token + " " + next) ||
        (ARTICLE_MODIFIER_WORD_RE.test(token) && !ARTICLE_LY_NOUN_RE.test(token))));
    inInfinitive = token === "to" || (inInfinitive && infinitiveAuxiliary);
    previous = token;
  }
  return false;
}

function startsArticleNounPhrase(text: string): boolean {
  const tokens = new RegExp(
    `[ \\t]+(?:${ARTICLE_DIMENSION_TOKEN}|${ARTICLE_MEASUREMENT_TOKEN}|${ARTICLE_QUANTITY_TOKEN}(?=[ \\t])|([a-z]+)(?:-[a-z]+)*\\b)`,
    "iyu",
  );
  let modifiers = 0;
  let afterTemporalModifier = false;
  let afterParticipialConditional = false;
  let afterPluralModifier = false;
  let needsMeasureWord = false;
  for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
    const token = match[0].trim().toLowerCase();
    const remainder = text.slice(tokens.lastIndex);
    const cardinal = ARTICLE_CARDINAL_RE.test(token);
    if (cardinal && ARTICLE_CARDINAL_ADJUNCT_RE.test(remainder)) return false;

    const word = match[1]?.toLowerCase();
    if (needsMeasureWord && (word === undefined || cardinal)) return false;
    if (afterParticipialConditional && afterPluralModifier &&
      (ARTICLE_PLURAL_VERB_RE.test(token) || ARTICLE_INTRANSITIVE_PAST_RE.test(token) ||
        ARTICLE_TRANSITIVE_PAST_RE.test(token))) return false;

    // A repetition word after "next" or "last" needs a head, as in "next time step".
    const repetitionModifier = afterTemporalModifier && ARTICLE_REPETITION_NOUN_RE.test(token);
    if (word !== undefined && !cardinal && !repetitionModifier) {
      if (token.length < 2 || ARTICLE_STOP_WORD_RE.test(word)) return false;
      const head = token.slice(token.lastIndexOf("-") + 1);
      if (ARTICLE_IRREGULAR_PLURAL_RE.test(head)) return false;
      const singular = !head.endsWith("s") || ARTICLE_SINGULAR_S_RE.test(head);
      if (needsMeasureWord) {
        // A bare plural cardinal needs both a measure word and a head.
        if (!singular || !ARTICLE_MEASURE_WORD_RE.test(token)) return false;
        needsMeasureWord = false;
      } else if (!ARTICLE_MODIFIER_WORD_RE.test(word) || ARTICLE_LY_NOUN_RE.test(word)) {
        if (singular) return !afterParticipialConditional || !hasConditionalClausePredicate(remainder);
        afterPluralModifier = true;
      }
    }
    if (modifiers === 3) return false;
    modifiers += 1;
    afterTemporalModifier = token === "next" || token === "last";
    afterParticipialConditional ||= token === "given" || token === "provided";
    needsMeasureWord ||= cardinal && token !== "one" && token !== "1";
  }
  return false;
}

const ARTICLE_SUPERSCRIPT_EXPONENT_RE = /(?<=\p{Nd})[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu;

function containsSingleChoiceReveal(syntax: string, choiceLetter: string, rawText: string): boolean {
  const optionText = syntax.replace(/\s+/g, " ");
  const escaped = escapeRegExp(choiceLetter);
  const option = `${OPTION_WRAPPER_OPEN}?\\s*${escaped}(?:\\s*${OPTION_WRAPPER_CLOSE})?(?!${ALPHA_NUM_IDENT_CHAR})`;
  const separator = /(?:-{1,2}>|={1,2}>|[-–—―→⇒⟶⟹:：=])/.source;
  const copula = /(?:(?:is|为|是)\s*)?/.source;
  const afterCue = `\\s*${copula}${separator}?\\s*${option}`;
  const patterns = [
    new RegExp(BOUNDED_ANSWER_CUE + afterCue, "iu"),
    new RegExp(`${BARE_CHOICE_VERB}\\s*${copula}${separator}\\s*${option}`, "iu"),
    new RegExp(`(?<!${NON_CJK_WORD_CHAR})${option}\\s+is\\s+correct(?!${NON_CJK_WORD_CHAR})`, "iu"),
    new RegExp(`=\\s*${option}`, "iu"),
  ];
  if (patterns.some(pattern => pattern.test(optionText))) return true;

  const bareChoice = new RegExp(`${BARE_CHOICE_VERB}\\s*${copula}(${option})`, "giu");
  // NFKC collapses "10²" to "102". Keep the exponent explicit when parsing modifiers.
  const withExponents = rawText.replace(ARTICLE_SUPERSCRIPT_EXPONENT_RE, "^$&");
  const articleSyntax = withExponents === rawText ? syntax : normalizeOptionSyntax(normalizeLeakSyntax(withExponents));
  for (const match of articleSyntax.matchAll(bareChoice)) {
    const remainder = articleSyntax.slice(match.index + match[0].length);
    // "Correct a mistake" uses an article. Case, wrappers and line breaks
    // distinguish it from a choice label in the same position.
    if (match[1]?.trim() !== "a" || !startsArticleNounPhrase(remainder)) return true;
  }

  const wrapped = new RegExp(
    `${OPTION_WRAPPER_OPEN}\\s*${escaped}(${OPTION_END_PUNCTUATION})${OPTION_WRAPPER_CLOSE}`,
    "giu",
  );
  // Keep line breaks at the same offsets as the collapsed spaces. A wrapper can
  // span a line break, but adjacent options must connect on the same line.
  const lineBoundaries = LINE_BREAK_RE.test(syntax)
    ? syntax.replace(/\s+/g, space => LINE_BREAK_RE.test(space) ? "\n" : " ")
    : null;
  for (const match of optionText.matchAll(wrapped)) {
    const end = match.index + match[0].length;
    const nextLineBreak = lineBoundaries?.indexOf("\n", end) ?? -1;
    const remainder = optionText.slice(end, nextLineBreak < 0 ? undefined : nextLineBreak);
    const endsInsideWrapper = OPTION_SENTENCE_TERMINATOR_RE.test(match[1] ?? "") &&
      BOUNDARY_AFTER_QUOTED_END_RE.test(remainder);
    if (!endsInsideWrapper && !END_AFTER_OPTION_RE.test(remainder)) continue;

    const previousLineBreak = lineBoundaries?.lastIndexOf("\n", match.index - 1) ?? -1;
    const prefix = optionText.slice(previousLineBreak + 1, match.index);
    if (PRECEDING_OPTION_RE.test(prefix) || NEXT_OPTION_RE.test(remainder)) continue;
    return true;
  }
  return false;
}

const COMPOUND_BINARY_ADD_SUB_RE =
  /(?<=[0-9a-zA-Z\p{Script=Greek})\]}|'\u2032\u2019!%])\s*([+-])\s*(?=[0-9a-zA-Z\p{Script=Greek}([{|\u221A\\])/gu;

const MATH_EXPR_ATOM_CHARS =
  "[\\p{N}a-z\\p{Script=Greek}()\\[\\]{}|'\\u2032\\u2019.,_!%\\\\\\u221A]";

const COMPOUND_MATH_EXPR_RE = new RegExp(
  `^(?:[+-]|\\+-|-\\+)?${MATH_EXPR_ATOM_CHARS}+(?:[+\\-*\\/^]${MATH_EXPR_ATOM_CHARS}+)+$`,
  "iu",
);

const STANDALONE_SIGNED_LITERAL_RE = new RegExp(
  `^(?:\\+-|-\\+|[+-])(?:` +
    `${UNSIGNED_DECIMAL_LITERAL}(?:\\/\\d+)?` +
    `|(?:${GREEK_OR_CONST}|sqrt\\([^)]+\\)|[a-z]\\^\\d+)(?:\\/[a-z0-9]+)?` +
    `|\\d+(?:\\/\\d+)?\\s*(?:${GREEK_OR_CONST}|sqrt\\([^)]+\\))` +
    `|\\d+[a-z](?:\\^\\d+)?` +
  `)$`,
  "i",
);

function collapseBinaryAddSubWhitespace(canonicalizedText: string): string {
  let current = canonicalizedText;
  while (true) {
    const next = current.replace(COMPOUND_BINARY_ADD_SUB_RE, "$1");
    if (next === current) break;
    current = next;
  }
  return current;
}

function compactJsonPunctuation(text: string): string {
  return text.replace(/"(?:[^"\\]|\\[\s\S])*"|\s*([[{}\],:])\s*/g, (match, punctuation: string | undefined) =>
    punctuation ?? match,
  );
}

function normalizeOptionLabel(value: string): string {
  return optionLabelFromSyntax(normalizeOptionSyntax(normalizeLeakSyntax(value)));
}

function optionLabelFromSyntax(syntax: string): string {
  const label = syntax.replace(/\s+/g, " ").trim();
  const unwrapped = /^\x60([^\x60]+)\x60$/u.exec(label)?.[1]?.trim() ?? label;
  return WRAPPED_OPTION_LABEL_RE.exec(unwrapped)?.[1] ?? unwrapped;
}

function protectedPrimitiveText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
    ? String(value).trim()
    : null;
}

function protectedArrayMemberText(
  value: unknown,
  remainingDecodes = MAX_PROTECTED_JSON_DECODES,
  numberSpelling?: unknown,
): string | null {
  if (typeof value === "number" && typeof numberSpelling === "string") {
    return numberSpelling;
  }
  for (let depth = 0; depth < remainingDecodes && typeof value === "string"; depth += 1) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('"')) break;
    const decoded = parseSerializedProtectedValue(trimmed);
    if (typeof decoded?.value !== "string") break;
    value = decoded.value;
  }
  return value === null ? "null" : protectedPrimitiveText(value);
}

function normalizeOptionLabels(values: readonly unknown[], numberSpellings?: readonly unknown[]): string[] | null {
  const labels: string[] = [];
  for (const [index, value] of values.entries()) {
    const text = protectedArrayMemberText(value, MAX_PROTECTED_JSON_DECODES, numberSpellings?.[index]);
    if (text === null) return null;
    const label = normalizeOptionLabel(text);
    if (!label) return null;
    labels.push(label);
  }
  return labels;
}

function optionSequenceSource(
  labels: readonly string[],
  decimalKeys?: readonly (string | null)[],
  decimalTokenSource = DECIMAL_TOKEN_SOURCE,
): string {
  const sequence = labels.map((label, index) => {
    if (decimalKeys?.[index] != null) {
      return `(?:[+-][^\\S\\r\\n\\u2028\\u2029]*)?(${decimalTokenSource})`;
    }
    return DECIMAL_LITERAL_RE.test(label)
      ? standaloneNumericOrSymbolicSource(label)
      : escapeRegExp(label).replace(/ /g, "\\s+");
  }).join(OPTION_SEQUENCE_SEPARATOR);
  return `(?<!${NON_CJK_WORD_CHAR})${sequence}(?!${NON_CJK_WORD_CHAR})`;
}

function containsOptionSequence(text: string, labels: readonly string[]): boolean {
  const decimalKeys = labels.map(canonicalDecimalValueKey);
  const numericKeys = decimalKeys.filter(key => key !== null);
  if (numericKeys.length === 0) return new RegExp(optionSequenceSource(labels), "iu").test(text);

  let mathRanges: ReturnType<typeof findMathRanges> | undefined;
  const getMathRanges = () => mathRanges ??= findMathRanges(text);
  // An unspaced comma can also separate two array entries. Try that
  // interpretation in the sequence matcher while keeping scalar tokens whole.
  const decimalSources = /\d,\d/.test(text)
    ? [DECIMAL_TOKEN_SOURCE, COMMA_LIST_DECIMAL_TOKEN_SOURCE]
    : [DECIMAL_TOKEN_SOURCE];
  for (const decimalSource of decimalSources) {
    const sequence = optionSequenceSource(labels, decimalKeys, decimalSource);
    // Advance by one code point so a wrong numeric value does not skip an
    // overlapping sequence that starts at the next label.
    const pattern = new RegExp(`(?=${sequence})[\\s\\S]`, "dgiu");
    for (const match of text.matchAll(pattern)) {
      if (numericKeys.every((key, index) => {
        const start = match.indices?.[index + 1]?.[0];
        const magnitude = match[index + 1];
        return start !== undefined && magnitude !== undefined &&
          matchesDecimalValueAt(text, magnitude, start, key, getMathRanges);
      })) return true;
    }
  }
  return false;
}

interface DecodedProtectedValue {
  readonly value: string | object;
  readonly numberSpellings?: unknown;
}

function parseSerializedProtectedValue(rawSecret: string): DecodedProtectedValue | null {
  // Preserve JSON quoting and escapes when the protected value is already serialized.
  const serialized = rawSecret.trim();
  const startsJson = /^[[{"]/;
  const json = startsJson.test(serialized) ? serialized : normalizeLeakSyntax(serialized).trim();
  if (!startsJson.test(json)) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === "string") return { value };
    if (typeof value !== "object" || value === null) return null;

    // Quote every numeric token in the parallel tree so its value never goes
    // through IEEE-754. The other tree distinguishes JSON numbers from strings.
    const spellingJson = json.replace(
      /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      token => token.startsWith('"') ? token : JSON.stringify(token),
    );
    return spellingJson === json ? { value } : { value, numberSpellings: JSON.parse(spellingJson) };
  } catch {
    return null;
  }
}

function containsArrayAnswerLeak(
  optionText: string,
  normalizedStem: string,
  normalizedSecret: string,
  rawSecret: string,
): boolean {
  if (!normalizedSecret.startsWith("[")) return false;
  const decoded = parseSerializedProtectedValue(rawSecret);
  const values = decoded?.value;
  if (!Array.isArray(values) || values.length === 0) return false;

  const compactStem = compactJsonPunctuation(normalizedStem);
  if (compactStem.includes(compactJsonPunctuation(normalizedSecret))) return true;

  // Normalize each decoded label before building the ordered sequence.
  if (values.length < 2) return false;
  const spellings = decoded?.numberSpellings;
  const labels = normalizeOptionLabels(values, Array.isArray(spellings) ? spellings : undefined);
  return labels !== null && (
    containsOptionSequence(optionText, labels) ||
    containsOptionSequence(normalizedStem, labels.map(normalizeComparableText))
  );
}

/**
 * Checks whether a candidate stem/text leaks a secret answer/solution value, including:
 * - exact normalized equality (after symmetric Unicode math canonicalization)
 * - non-trivial substring or multi-segment solution excerpts
 * - whitespace-tolerant equations/inequalities and compound `+`/`-` math expressions (`x = 2 + 3` <-> `x=2+3`, `a + b` <-> `a+b`, `2x - 1` <-> `2x-1`)
 * - short single-token numeric/symbolic answers (`"42"`, `"−7"`, `"0.5"`, `"½"`, `"π/2"`, `"√2"`, `"±3"`, `"∞"`)
 * - single-letter choice answer reveals (e.g. `"Correct option is B"`, `"(B)"`)
 */
export function containsAnswerLeak(
  rawText: string,
  secretText: string,
  options: { readonly includeShortTokens?: boolean } = {},
): boolean {
  const stemSyntax = normalizeLeakSyntax(rawText);
  const optionSyntax = normalizeOptionSyntax(stemSyntax);
  const casedStem = canonicalizeMathNotationPreserveCase(stemSyntax);
  const normalizedStem = casedStem.toLowerCase();
  const normalizedSecret = normalizeComparableText(secretText);
  if (!normalizedStem || !normalizedSecret) return false;
  if (normalizedStem === normalizedSecret) return true;
  if (containsArrayAnswerLeak(optionSyntax, normalizedStem, normalizedSecret, secretText)) return true;
  const optionSecret = normalizeComparableText(normalizeOptionLabel(secretText));
  if (optionSecret && normalizeComparableText(optionLabelFromSyntax(optionSyntax)) === optionSecret) {
    return true;
  }

  const compactStem = collapseBinaryAddSubWhitespace(normalizedStem);
  const compactSecret = collapseBinaryAddSubWhitespace(normalizedSecret);
  if (!STANDALONE_SIGNED_LITERAL_RE.test(normalizedSecret) && !DECIMAL_LITERAL_RE.test(normalizedSecret) &&
    compactStem === compactSecret) {
    return true;
  }

  const includeShortTokens = options.includeShortTokens ?? true;
  if (includeShortTokens) {
    if (SINGLE_CHOICE_LETTER_RE.test(optionSecret) && containsSingleChoiceReveal(optionSyntax, optionSecret, rawText)) {
      return true;
    }
    if (UNSIGNED_OPTION_SCALAR_RE.test(optionSecret) && containsStandaloneNumericOrSymbolicToken(optionSyntax, optionSecret)) {
      return true;
    }
  }
  let signedStemWithLineBreaks: string | undefined;
  const stemForToken = (signed: boolean): string => signed && LINE_BREAK_RE.test(stemSyntax)
    ? (signedStemWithLineBreaks ??= canonicalizeMathNotationPreserveCase(stemSyntax, true))
    : casedStem;

  for (const segment of extractLeakSegments(normalizedSecret)) {
    const isStandaloneSigned = STANDALONE_SIGNED_LITERAL_RE.test(segment);
    // Every decimal spelling, including long literals and exponents containing
    // a sign, must use token bounds instead of the generic substring paths.
    if (DECIMAL_LITERAL_RE.test(segment)) {
      if ((includeShortTokens || segment.length >= 6) &&
        containsStandaloneNumericOrSymbolicToken(stemForToken(true), segment)) return true;
      continue;
    }
    const compactSegment = isStandaloneSigned
      ? segment
      : collapseBinaryAddSubWhitespace(segment);

    if (segment.length >= 6 && containsCjkBoundedSubstring(normalizedStem, segment)) {
      return true;
    }
    if (!isStandaloneSigned && compactSegment.length >= 6 && containsCjkBoundedSubstring(compactStem, compactSegment)) {
      return true;
    }
    const tokenCount = segment.split(/\s+/).filter(Boolean).length;
    if (tokenCount >= 2 && segment.length >= 4 && containsTokenBoundedSubstring(normalizedStem, segment)) {
      return true;
    }
    if (!isStandaloneSigned) {
      const compactTokenCount = compactSegment.split(/\s+/).filter(Boolean).length;
      if (
        compactTokenCount >= 2 &&
        compactSegment.length >= 4 &&
        containsTokenBoundedSubstring(compactStem, compactSegment)
      ) {
        return true;
      }
      if (
        includeShortTokens &&
        compactTokenCount === 1 &&
        compactSegment.length >= 3 &&
        COMPOUND_MATH_EXPR_RE.test(compactSegment) &&
        containsStandaloneNumericOrSymbolicToken(compactStem, compactSegment)
      ) {
        return true;
      }
    }
    if (RELATION_OP_RE.test(compactSegment)) {
      const compactRel = compactSegment.replace(/\s*(<=|>=|!=|~=|==|=|<|>)\s*/g, "$1");
      if (compactRel.length >= 3) {
        const relRegexSource = compactRel
          .split(/(<=|>=|!=|~=|==|=|<|>)/)
          .map(part =>
            RELATION_OP_RE.test(part) ? `\\s*${escapeRegExp(part)}\\s*` : escapeRegExp(part),
          )
          .join("");
        const relPattern = new RegExp(
          `(?<!${ALPHA_NUM_IDENT_CHAR})${relRegexSource}(?!${ALPHA_NUM_IDENT_CHAR})`,
          "iu",
        );
        if (relPattern.test(normalizedStem) || (!isStandaloneSigned && relPattern.test(compactStem))) {
          return true;
        }
      }
    }
    if (includeShortTokens) {
      if (segment.length >= 1 && segment.length < 6 && CJK_SCRIPT_RE.test(segment)) {
        if (containsCjkBoundedSubstring(normalizedStem, segment)) {
          return true;
        }
      } else if (tokenCount === 1) {
        if (
          SHORT_NUMERIC_OR_SYMBOLIC_ANSWER_RE.test(segment) ||
          UNICODE_MATH_SYMBOL_RE.test(segment)
        ) {
          // Ordinary matching folds whitespace. Signed tokens need the original
          // sentence boundaries to decide whether a unit group is algebraic.
          if (containsStandaloneNumericOrSymbolicToken(stemForToken(isStandaloneSigned), segment)) {
            return true;
          }
        } else if (segment.length >= 2 && segment.length < 6 && /[\p{L}\p{N}]/u.test(segment)) {
          if (containsUnicodeWordBoundedToken(normalizedStem, segment)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const SHA256_H0: readonly [number, number, number, number, number, number, number, number] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function sha256Utf8Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let state0: number = SHA256_H0[0];
  let state1: number = SHA256_H0[1];
  let state2: number = SHA256_H0[2];
  let state3: number = SHA256_H0[3];
  let state4: number = SHA256_H0[4];
  let state5: number = SHA256_H0[5];
  let state6: number = SHA256_H0[6];
  let state7: number = SHA256_H0[7];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = state0;
    let b = state1;
    let c = state2;
    let d = state3;
    let e = state4;
    let f = state5;
    let g = state6;
    let h = state7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state0 = (state0 + a) >>> 0;
    state1 = (state1 + b) >>> 0;
    state2 = (state2 + c) >>> 0;
    state3 = (state3 + d) >>> 0;
    state4 = (state4 + e) >>> 0;
    state5 = (state5 + f) >>> 0;
    state6 = (state6 + g) >>> 0;
    state7 = (state7 + h) >>> 0;
  }
  return [state0, state1, state2, state3, state4, state5, state6, state7]
    .map(value => value.toString(16).padStart(8, "0"))
    .join("");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeComparableText(value: string): string {
  return canonicalizeMathNotation(value);
}

const MAX_PROTECTED_PAYLOAD_DEPTH = 64;
const MAX_PROTECTED_PAYLOAD_NODES = 4_096;
const MAX_PROTECTED_JSON_DECODES = 8;

interface ProtectedAnswerTexts {
  readonly texts: Set<string>;
  readonly arrayOptionLabels: Set<string>;
  readonly mathOptionGroups: { members: ReadonlySet<string>; labels: string[] }[];
}

function collectSecretTexts(value: unknown): ProtectedAnswerTexts | null {
  const texts = new Set<string>();
  const arrayOptionLabels = new Set<string>();
  const mathOptionGroups: ProtectedAnswerTexts["mathOptionGroups"] = [];
  const ancestors = new Set<object>();
  let remainingNodes = MAX_PROTECTED_PAYLOAD_NODES;

  function collectArrayMembers(values: readonly string[]): void {
    const members = new Set(values.filter(Boolean));
    const labels = values.map(normalizeOptionLabel);
    if (labels.length >= 2 && labels.every(label => GREEK_OR_CONST_LABEL_RE.test(label))) {
      mathOptionGroups.push({ members, labels });
    } else {
      for (const text of members) texts.add(text);
      for (const label of labels) {
        if (label) arrayOptionLabels.add(label);
      }
    }
  }

  // Build JSON text from the inspected properties so serialization cannot
  // traverse unchecked values or execute getters and toJSON hooks.
  function inspect(
    current: unknown,
    depth: number,
    jsonDepth = 0,
    collectText = true,
    numberSpelling?: unknown,
  ): string | undefined {
    remainingNodes -= 1;
    if (depth > MAX_PROTECTED_PAYLOAD_DEPTH || remainingNodes < 0) {
      throw new RangeError("Protected payload exceeds inspection bounds");
    }
    if (current === undefined) return undefined;
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
      const rawNumber = typeof current === "number" && typeof numberSpelling === "string" ? numberSpelling : undefined;
      const text = rawNumber ?? String(current).trim();
      if (text && collectText) texts.add(text);
      if (rawNumber !== undefined) return rawNumber;
      if (typeof current === "string") {
        const decoded = parseSerializedProtectedValue(current);
        if (decoded !== null) {
          if (jsonDepth >= MAX_PROTECTED_JSON_DECODES) {
            throw new RangeError("Protected payload exceeds the JSON decoding bound");
          }
          inspect(decoded.value, depth + 1, jsonDepth + 1, collectText, decoded.numberSpellings);
        }
      }
      return JSON.stringify(current);
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      throw new TypeError("Protected payload contains unsupported or cyclic data");
    }

    const keys = Reflect.ownKeys(current);
    let arrayLength: number | null = null;
    if (Array.isArray(current)) {
      if (!isPlainLeaseArray(current, keys)) {
        throw new TypeError("Protected payload arrays must contain only indexed data");
      }
      arrayLength = current.length;
    } else {
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError("Protected payload must contain plain records");
      }
    }
    if ((arrayLength ?? 0) > remainingNodes || keys.length - (arrayLength === null ? 0 : 1) > remainingNodes) {
      throw new RangeError("Protected payload exceeds inspection bounds");
    }

    const parts = arrayLength === null ? [] : new Array<string>(arrayLength).fill("null");
    const arrayMembers = arrayLength === null ? undefined : new Array<string>(arrayLength).fill("");
    let indexedChildren = 0;
    ancestors.add(current);
    for (const key of keys) {
      if (arrayLength !== null && key === "length") continue;
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (!property || !Object.hasOwn(property, "value")) {
        throw new TypeError("Protected payload properties must be inspectable data");
      }
      const childSpelling: unknown = typeof numberSpelling === "object" && numberSpelling !== null
        ? Object.getOwnPropertyDescriptor(numberSpelling, key)?.value
        : undefined;
      const member = arrayMembers
        ? protectedArrayMemberText(property.value, MAX_PROTECTED_JSON_DECODES - jsonDepth, childSpelling)
        : null;
      if (arrayMembers && member !== null) arrayMembers[Number(key)] = member;
      const json = inspect(property.value, depth + 1, jsonDepth, member === null, childSpelling);
      if (typeof key !== "string") continue;
      if (arrayLength !== null) {
        parts[Number(key)] = json ?? "null";
        indexedChildren += 1;
      } else if (property.enumerable && json !== undefined) {
        parts.push(`${JSON.stringify(key)}:${json}`);
      }
    }
    ancestors.delete(current);

    if (arrayLength !== null) {
      remainingNodes -= arrayLength - indexedChildren;
      if (remainingNodes < 0) throw new RangeError("Protected payload exceeds inspection bounds");
      if (arrayMembers) collectArrayMembers(arrayMembers);
      const json = `[${parts.join(",")}]`;
      if (arrayLength > 0) texts.add(json);
      return json;
    }
    const json = `{${parts.join(",")}}`;
    if (parts.length > 0) texts.add(json);
    return json;
  }

  try {
    inspect(value, 0);
    return { texts, arrayOptionLabels, mathOptionGroups };
  } catch {
    return null;
  }
}

function containsProtectedAnswerLeak(text: string, protectedAnswers: ProtectedAnswerTexts): boolean {
  for (const secret of protectedAnswers.texts) {
    if (containsAnswerLeak(text, secret)) return true;
  }
  if (protectedAnswers.arrayOptionLabels.size === 0 && !protectedAnswers.mathOptionGroups.length) return false;

  const optionSyntax = normalizeOptionSyntax(normalizeLeakSyntax(text));
  for (const label of protectedAnswers.arrayOptionLabels) {
    if (containsAnswerLeak(optionSyntax, label)) return true;
  }
  for (const { members, labels } of protectedAnswers.mathOptionGroups) {
    // Ignore the reversed list in a comparison sentence only when checking its
    // members. The ordered list and any independently protected value still apply.
    const reversedSequence = optionSequenceSource(labels.slice().reverse());
    const comparison = new RegExp(
      `(?:^|(?<=${OPTION_SENTENCE_TERMINATOR_RE.source}\\s|[\\r\\n\\u2028\\u2029]))[^\\S\\r\\n\\u2028\\u2029]*` +
      `compare\\s+(?:${OPTION_WRAPPER_OPEN}\\s*)?${reversedSequence}(?:${OPTION_CLOSING})?(?=${OPTION_SENTENCE_END})`,
      "giu",
    );
    const withoutComparison = optionSyntax.replace(comparison, match => LINE_BREAK_RE.test(match) ? match : " ");
    if (labels.some(label => containsAnswerLeak(withoutComparison, label))) return true;
    const rawMemberText = withoutComparison === optionSyntax ? text : withoutComparison;
    for (const member of members) {
      if (containsAnswerLeak(rawMemberText, member)) return true;
    }
  }
  return false;
}

function canonicalizeForFingerprint(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : '"non-finite"';
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeForFingerprint(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalizeForFingerprint(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function serializeFsrsCard(card: Card): OfflineFsrsMemoryState {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReviewAtMs: card.last_review ? card.last_review.getTime() : null,
  };
}

function cloneServerSnapshot(snapshot: ServerFlashcardSnapshot): ServerFlashcardSnapshot {
  return {
    ...snapshot,
    fsrs: snapshot.fsrs ? { ...snapshot.fsrs } : null,
  };
}

function cloneLedgerEntry(entry: OfflineOutboxLedgerEntry): OfflineOutboxLedgerEntry {
  return {
    ...entry,
    ...(entry.payloadSummary ? { payloadSummary: { ...entry.payloadSummary } } : {}),
    receipt: {
      ...entry.receipt,
      strippedClientFlags: [...entry.receipt.strippedClientFlags],
      nextSnapshot: cloneServerSnapshot(entry.receipt.nextSnapshot),
    },
  };
}

function createNullProtoRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function setOwnRecordProperty<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function getOwnRecordProperty<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isValidFsrsMemoryState(value: unknown): value is OfflineFsrsMemoryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fsrsState = value as Partial<OfflineFsrsMemoryState>;
  return (
    typeof fsrsState.stability === "number" &&
    Number.isFinite(fsrsState.stability) &&
    typeof fsrsState.difficulty === "number" &&
    Number.isFinite(fsrsState.difficulty) &&
    typeof fsrsState.elapsedDays === "number" &&
    Number.isFinite(fsrsState.elapsedDays) &&
    typeof fsrsState.scheduledDays === "number" &&
    Number.isFinite(fsrsState.scheduledDays) &&
    isNonNegativeSafeInteger(fsrsState.learningSteps) &&
    isNonNegativeSafeInteger(fsrsState.reps) &&
    isNonNegativeSafeInteger(fsrsState.lapses) &&
    typeof fsrsState.state === "number" &&
    Number.isFinite(fsrsState.state) &&
    (fsrsState.lastReviewAtMs === null || isValidTimestamp(fsrsState.lastReviewAtMs))
  );
}

function isValidServerFlashcardSnapshot(value: unknown): value is ServerFlashcardSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Partial<ServerFlashcardSnapshot>;
  return (
    isNonEmptyString(snapshot.cardId) &&
    isNonNegativeSafeInteger(snapshot.revision) &&
    (snapshot.lastServerReviewedAtMs === null || isValidTimestamp(snapshot.lastServerReviewedAtMs)) &&
    isValidTimestamp(snapshot.dueAtMs) &&
    typeof snapshot.intervalDays === "number" &&
    Number.isFinite(snapshot.intervalDays) &&
    snapshot.intervalDays >= 0 &&
    isNonNegativeSafeInteger(snapshot.reps) &&
    isNonNegativeSafeInteger(snapshot.lapses) &&
    (snapshot.lastGrade === null ||
      (typeof snapshot.lastGrade === "string" && VALID_RAW_RATINGS.has(snapshot.lastGrade))) &&
    isValidTimestamp(snapshot.updatedAtMs) &&
    (snapshot.fsrs === null || isValidFsrsMemoryState(snapshot.fsrs))
  );
}

function isValidLedgerEntry(value: unknown): value is OfflineOutboxLedgerEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<OfflineOutboxLedgerEntry>;
  if (
    !isNonEmptyString(entry.leaseId) ||
    typeof entry.seq !== "number" ||
    !Number.isSafeInteger(entry.seq) ||
    entry.seq < 1 ||
    !isNonEmptyString(entry.payloadFingerprint)
  ) {
    return false;
  }
  if (entry.payloadSummary !== undefined) {
    if (
      typeof entry.payloadSummary !== "object" ||
      entry.payloadSummary === null ||
      Array.isArray(entry.payloadSummary)
    ) {
      return false;
    }
    const summary = entry.payloadSummary as Partial<OfflineOutboxPayloadSummary>;
    if (
      !isNonEmptyString(summary.cardId) ||
      typeof summary.rating !== "string" ||
      !VALID_RAW_RATINGS.has(summary.rating) ||
      !isNonNegativeSafeInteger(summary.expectedCardRevision) ||
      (summary.clientReviewedAtMs !== null &&
        (typeof summary.clientReviewedAtMs !== "number" || !Number.isFinite(summary.clientReviewedAtMs)))
    ) {
      return false;
    }
  }
  const receipt = entry.receipt as Partial<OfflineSettledReceipt> | undefined;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return false;
  if (
    !isNonEmptyString(receipt.leaseId) ||
    typeof receipt.seq !== "number" ||
    !Number.isSafeInteger(receipt.seq) ||
    receipt.seq < 1 ||
    !isNonEmptyString(receipt.cardId) ||
    typeof receipt.rawRating !== "string" ||
    !VALID_RAW_RATINGS.has(receipt.rawRating) ||
    (receipt.effectiveRating !== "again" &&
      receipt.effectiveRating !== "hard" &&
      receipt.effectiveRating !== "good") ||
    typeof receipt.clampedFromEasy !== "boolean" ||
    receipt.authorityClock !== "server_receipt" ||
    !isValidTimestamp(receipt.effectiveReviewedAtMs) ||
    receipt.delayedCheckMinted !== false ||
    receipt.allowMasteryPromotion !== false ||
    receipt.transferVerified !== false ||
    !Array.isArray(receipt.strippedClientFlags) ||
    !receipt.strippedClientFlags.every(flag => typeof flag === "string") ||
    !isNonNegativeSafeInteger(receipt.previousRevision) ||
    !isNonNegativeSafeInteger(receipt.newRevision) ||
    !isValidServerFlashcardSnapshot(receipt.nextSnapshot)
  ) {
    return false;
  }
  const canonicalEntryLeaseId = canonicalizeIdentifier(entry.leaseId);
  const canonicalReceiptLeaseId = canonicalizeIdentifier(receipt.leaseId);
  const canonicalReceiptCardId = canonicalizeIdentifier(receipt.cardId);
  const canonicalNextSnapshotCardId = canonicalizeIdentifier(receipt.nextSnapshot.cardId);
  if (
    canonicalEntryLeaseId !== canonicalReceiptLeaseId ||
    entry.seq !== receipt.seq ||
    canonicalReceiptCardId !== canonicalNextSnapshotCardId ||
    receipt.newRevision !== receipt.nextSnapshot.revision
  ) {
    return false;
  }
  if (
    entry.payloadSummary !== undefined &&
    canonicalizeIdentifier(entry.payloadSummary.cardId) !== canonicalReceiptCardId
  ) {
    return false;
  }
  return true;
}

function canonicalizeLedgerKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  const sepIdx = trimmed.lastIndexOf(":");
  if (sepIdx <= 0 || sepIdx === trimmed.length - 1) return null;
  const rawLeasePart = trimmed.slice(0, sepIdx);
  const rawSeqPart = trimmed.slice(sepIdx + 1);
  if (!/^[1-9]\d*$/.test(rawSeqPart)) return null;
  const seq = Number(rawSeqPart);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  if (!isNonEmptyString(rawLeasePart)) return null;
  return offlineOutboxIdempotencyKey(rawLeasePart, seq);
}

function isValidOptionalClientReviewedAtMs(value: unknown): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function toServerCardRecord(
  cards:
    | Readonly<Record<string, ServerFlashcardSnapshot>>
    | ReadonlyMap<string, ServerFlashcardSnapshot>,
): Record<string, ServerFlashcardSnapshot> {
  if (typeof cards !== "object" || cards === null || Array.isArray(cards)) {
    throw new TypeError("serverCards must be a record or Map of ServerFlashcardSnapshot entries.");
  }
  const out = createNullProtoRecord<ServerFlashcardSnapshot>();
  const entries = cards instanceof Map ? cards.entries() : Object.entries(cards);
  for (const [cardId, snapshot] of entries) {
    if (!isNonEmptyString(cardId)) {
      throw new TypeError("serverCards contains an empty or non-string cardId key.");
    }
    if (!isValidServerFlashcardSnapshot(snapshot)) {
      throw new TypeError(`serverCards entry for cardId "${cardId}" is structurally invalid.`);
    }
    const canonicalId = canonicalizeIdentifier(cardId);
    const canonicalSnapshotCardId = canonicalizeIdentifier(snapshot.cardId);
    if (canonicalId !== canonicalSnapshotCardId) {
      throw new TypeError(
        `serverCards key "${cardId}" does not match embedded snapshot.cardId "${snapshot.cardId}".`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(out, canonicalId)) {
      throw new TypeError(
        `serverCards contains duplicate/conflicting canonical cardId "${canonicalId}" (from key "${cardId}").`,
      );
    }
    setOwnRecordProperty(out, canonicalId, cloneServerSnapshot({ ...snapshot, cardId: canonicalId }));
  }
  return out;
}

function toLedgerRecord(
  ledger:
    | Readonly<Record<string, OfflineOutboxLedgerEntry>>
    | ReadonlyMap<string, OfflineOutboxLedgerEntry>
    | undefined,
): Record<string, OfflineOutboxLedgerEntry> {
  const out = createNullProtoRecord<OfflineOutboxLedgerEntry>();
  if (ledger === undefined) return out;
  if (typeof ledger !== "object" || ledger === null || Array.isArray(ledger)) {
    throw new TypeError("processedLedger must be a record or Map of OfflineOutboxLedgerEntry entries.");
  }
  const entries = ledger instanceof Map ? ledger.entries() : Object.entries(ledger);
  for (const [ledgerKey, entry] of entries) {
    if (!isNonEmptyString(ledgerKey)) {
      throw new TypeError("processedLedger contains an empty or non-string key.");
    }
    if (!isValidLedgerEntry(entry)) {
      throw new TypeError(`processedLedger entry for key "${ledgerKey}" is structurally invalid.`);
    }
    const canonicalKey = offlineOutboxIdempotencyKey(entry.leaseId, entry.seq);
    const canonicalMapKey = canonicalizeLedgerKey(ledgerKey);
    if (canonicalMapKey !== canonicalKey) {
      throw new TypeError(
        `processedLedger key "${ledgerKey}" does not match embedded entry identity "${canonicalKey}".`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(out, canonicalKey)) {
      throw new TypeError(
        `processedLedger contains duplicate/conflicting canonical key "${canonicalKey}" (from key "${ledgerKey}").`,
      );
    }
    setOwnRecordProperty(out, canonicalKey, cloneLedgerEntry(entry));
  }
  return out;
}

function sanitizeLeaseCandidate(
  candidate: OfflineLeaseCardCandidate,
  protectedAnswers: ProtectedAnswerTexts,
):
  | { readonly ok: true; readonly card: OfflineLeaseCard }
  | {
      readonly ok: false;
      readonly code: "invalid_card_payload" | "miss_variant_stem_required" | "miss_variant_answer_leak";
      readonly httpStatus: 400 | 422;
      readonly message: string;
      readonly cardId?: string;
    } {
  const candidateCardId = isSafeIdentifier(candidate.cardId) ? candidate.cardId : undefined;
  if (!candidateCardId) {
    return {
      ok: false,
      code: "invalid_card_payload",
      httpStatus: 400,
      message: "Lease card candidate must provide a safe non-empty cardId (reserved property keys like __proto__, constructor, and prototype are forbidden).",
    };
  }
  if (!isNonNegativeSafeInteger(candidate.cardRevision)) {
    return {
      ok: false,
      code: "invalid_card_payload",
      httpStatus: 400,
      cardId: candidateCardId,
      message: `Card ${candidateCardId} must have a non-negative integer cardRevision.`,
    };
  }
  if (candidate.lastServerReviewedAtMs !== null && !isValidTimestamp(candidate.lastServerReviewedAtMs)) {
    return {
      ok: false,
      code: "invalid_card_payload",
      httpStatus: 400,
      cardId: candidateCardId,
      message: `Card ${candidateCardId} has an invalid lastServerReviewedAtMs.`,
    };
  }

  if (candidate.cardKind === "flashcard") {
    if (!isNonEmptyString(candidate.prompt) || !isNonEmptyString(candidate.backSummary)) {
      return {
        ok: false,
        code: "invalid_card_payload",
        httpStatus: 400,
        cardId: candidateCardId,
        message: `Flashcard ${candidateCardId} requires non-empty prompt and backSummary.`,
      };
    }
    // Fail closed if a flashcard candidate carries any forbidden exam/miss-variant secret fields
    // (`sealedPayload`, `answerKey`, `canonicalSolution`, `gradingRubric`, `referenceAnswer`).
    const rawCandidate = candidate as Record<string, unknown>;
    for (const forbiddenField of FORBIDDEN_MISS_VARIANT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(rawCandidate, forbiddenField)) continue;
      const value = rawCandidate[forbiddenField];
      if (value !== undefined && value !== null) {
        return {
          ok: false,
          code: "miss_variant_answer_leak",
          httpStatus: 422,
          cardId: candidateCardId,
          message: `Flashcard ${candidateCardId} refused: forbidden sealed/answer field ${forbiddenField} is not permitted on flashcard lease candidates.`,
        };
      }
    }
    // Check BOTH prompt AND backSummary against solution/answer-key directives and sibling secret payloads.
    if (
      containsSolutionDirectiveMarker(candidate.prompt) ||
      containsSolutionDirectiveMarker(candidate.backSummary)
    ) {
      return {
        ok: false,
        code: "miss_variant_answer_leak",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Flashcard ${candidateCardId} refused: prompt or backSummary contains solution/answer directive markup.`,
      };
    }
    if (
      containsProtectedAnswerLeak(candidate.prompt, protectedAnswers) ||
      containsProtectedAnswerLeak(candidate.backSummary, protectedAnswers)
    ) {
      return {
        ok: false,
        code: "miss_variant_answer_leak",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Flashcard ${candidateCardId} refused: prompt or backSummary leaks protected sealed/answer material.`,
      };
    }
    const sanitized: OfflineLeasedStandardFlashcard = {
      cardId: canonicalizeIdentifier(candidateCardId),
      cardKind: "flashcard",
      cardRevision: candidate.cardRevision,
      lastServerReviewedAtMs: candidate.lastServerReviewedAtMs,
      prompt: candidate.prompt,
      backSummary: candidate.backSummary,
    };
    return { ok: true, card: sanitized };
  }

  if (candidate.cardKind === "miss_variant") {
    if (!isSafeIdentifier(candidate.freshVariantId)) {
      return {
        ok: false,
        code: isNonEmptyString(candidate.freshVariantId) ? "invalid_card_payload" : "miss_variant_stem_required",
        httpStatus: isNonEmptyString(candidate.freshVariantId) ? 400 : 422,
        cardId: candidateCardId,
        message: `Miss variant card ${candidateCardId} must include a safe non-empty freshVariantId.`,
      };
    }
    if (!isNonEmptyString(candidate.freshVariantStem)) {
      return {
        ok: false,
        code: "miss_variant_stem_required",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Miss variant card ${candidateCardId} must include non-empty freshVariantId and freshVariantStem.`,
      };
    }
    if (containsSolutionDirectiveMarker(candidate.freshVariantStem)) {
      return {
        ok: false,
        code: "miss_variant_answer_leak",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Miss variant card ${candidateCardId} refused: freshVariantStem contains solution/answer directive markup.`,
      };
    }
    // Check the stem against protected values from this card and its siblings.
    if (containsProtectedAnswerLeak(candidate.freshVariantStem, protectedAnswers)) {
      return {
        ok: false,
        code: "miss_variant_answer_leak",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Miss variant card ${candidateCardId} refused: freshVariantStem leaks protected answer/sealed material.`,
      };
    }

    // Strict allowlist construction: physically excludes answerKey, canonicalSolution,
    // gradingRubric, sealedPayload, referenceAnswer, and any unknown properties.
    const sanitized: OfflineLeasedMissVariantCard = {
      cardId: canonicalizeIdentifier(candidateCardId),
      cardKind: "miss_variant",
      cardRevision: candidate.cardRevision,
      lastServerReviewedAtMs: candidate.lastServerReviewedAtMs,
      freshVariantId: canonicalizeIdentifier(candidate.freshVariantId),
      freshVariantStem: candidate.freshVariantStem,
    };
    return { ok: true, card: sanitized };
  }

  return {
    ok: false,
    code: "invalid_card_payload",
    httpStatus: 400,
    cardId: candidateCardId,
    message: `Card ${candidateCardId} has unsupported cardKind.`,
  };
}

/**
 * Runtime assertion helper guaranteeing a minted miss-variant card carries zero
 * forbidden answer-key / rubric / sealed-payload fields.
 */
export function hasForbiddenMissVariantFields(card: unknown): boolean {
  if (typeof card !== "object" || card === null) return false;
  const record = card as Record<string, unknown>;
  return FORBIDDEN_MISS_VARIANT_FIELDS.some(field => Object.prototype.hasOwnProperty.call(record, field));
}

export function createInitialOfflineFsrsSnapshot(
  cardId: string,
  nowMs: number,
  revision = 0,
): ServerFlashcardSnapshot {
  if (!isSafeIdentifier(cardId)) {
    throw new RangeError("cardId must be a safe non-empty identifier.");
  }
  const canonicalCardId = canonicalizeIdentifier(cardId);
  const initialCard = createEmptyCard(new Date(nowMs));
  return {
    cardId: canonicalCardId,
    revision,
    lastServerReviewedAtMs: null,
    dueAtMs: nowMs,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    lastGrade: null,
    updatedAtMs: nowMs,
    fsrs: serializeFsrsCard(initialCard),
  };
}

export function offlineOutboxIdempotencyKey(leaseId: string, seq: number): string {
  return `${canonicalizeIdentifier(leaseId)}:${seq}`;
}

export function computeOfflineOutboxPayloadFingerprint(entry: OfflineOutboxEntryInput): string {
  const normalizedEntry: OfflineOutboxEntryInput = {
    ...entry,
    leaseId: isNonEmptyString(entry.leaseId) ? canonicalizeIdentifier(entry.leaseId) : entry.leaseId,
    cardId: isNonEmptyString(entry.cardId) ? canonicalizeIdentifier(entry.cardId) : entry.cardId,
  };
  return sha256Utf8Hex(canonicalizeForFingerprint(normalizedEntry));
}

const LEASE_SCOPE_FIELDS = ["leaseId", "workspaceId", "learnerId", "issuedAtMs"];
const LEASE_REQUEST_FIELDS = [...LEASE_SCOPE_FIELDS, "candidates", "existingActiveLease"];
const LEASE_CARD_FIELDS = [
  "cardId", "cardKind", "cardRevision", "lastServerReviewedAtMs",
  "prompt", "backSummary", "freshVariantId", "freshVariantStem",
];
const EXISTING_LEASE_FIELDS = [
  ...LEASE_SCOPE_FIELDS, "schemaVersion", "status", "expiresAtMs", "supersededAtMs",
  "supersededByLeaseId", "revokedAtMs", "cards",
];

function isPlainLeaseRecord(value: unknown, knownFields: readonly string[], inspectAllOwnFields = false): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;

  const fields = [...knownFields, ...FORBIDDEN_MISS_VARIANT_FIELDS];
  const keys = inspectAllOwnFields ? new Set([...fields, ...Reflect.ownKeys(value)]) : fields;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property ? !Object.hasOwn(property, "value") : key in value) return false;
    const inherited = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, key);
    if (inherited && !Object.hasOwn(inherited, "value")) return false;
  }
  return true;
}

function isPlainLeaseArray(value: unknown, ownKeys?: readonly PropertyKey[]): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return false;
  if (prototype !== null && FORBIDDEN_MISS_VARIANT_FIELDS.some(field =>
    Object.getOwnPropertyDescriptor(Array.prototype, field) !== undefined ||
    Object.getOwnPropertyDescriptor(Object.prototype, field) !== undefined,
  )) return false;

  const length = value.length;
  return (ownKeys ?? Reflect.ownKeys(value)).every(key => {
    if (key === "length") return true;
    if (typeof key !== "string") return false;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
  });
}

function inspectLeaseCards<Card>(cards: readonly Card[]): Card[] | null {
  const inspected: Card[] = [];
  for (let index = 0; index < cards.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(cards, String(index));
    if (!property || !Object.hasOwn(property, "value") || !isPlainLeaseRecord(property.value, LEASE_CARD_FIELDS)) {
      return null;
    }
    inspected.push(property.value as Card);
  }
  return inspected;
}

function rejectUninspectableLeaseInput(): IssueOfflineFlashcardLeaseResult {
  return {
    ok: false,
    code: "miss_variant_answer_leak",
    httpStatus: 422,
    message: "Offline lease refused: the request or a card could not be inspected as plain data.",
  };
}

/**
 * Issues a 12-hour single-active offline flashcard lease for `(workspaceId, learnerId)`
 * containing `1..30` strictly sanitized cards. Any prior active lease for the same
 * `(workspaceId, learnerId)` is atomically marked `"superseded"`.
 */
export function issueOfflineFlashcardLease(
  input: IssueOfflineFlashcardLeaseInput,
): IssueOfflineFlashcardLeaseResult {
  if (!isPlainLeaseRecord(input, LEASE_REQUEST_FIELDS)) return rejectUninspectableLeaseInput();
  if (
    !isSafeIdentifier(input.leaseId) ||
    !isSafeIdentifier(input.workspaceId) ||
    !isSafeIdentifier(input.learnerId)
  ) {
    return {
      ok: false,
      code: "invalid_lease_scope",
      httpStatus: 400,
      message: "leaseId, workspaceId, and learnerId must be safe non-empty identifiers (reserved property keys are forbidden).",
    };
  }
  if (!isValidTimestamp(input.issuedAtMs)) {
    return {
      ok: false,
      code: "invalid_timestamp",
      httpStatus: 400,
      message: "issuedAtMs must be a finite non-negative timestamp.",
    };
  }
  const candidateList = input.candidates;
  if (!isPlainLeaseArray(candidateList)) return rejectUninspectableLeaseInput();
  if (candidateList.length === 0) {
    return {
      ok: false,
      code: "empty_lease_cards",
      httpStatus: 400,
      message: "Offline lease requires at least 1 card.",
    };
  }
  if (candidateList.length > MAX_OFFLINE_LEASE_CARDS) {
    return {
      ok: false,
      code: "lease_card_limit_exceeded",
      httpStatus: 400,
      message: `Offline lease cannot exceed ${MAX_OFFLINE_LEASE_CARDS} cards.`,
    };
  }

  const leaseId = canonicalizeIdentifier(input.leaseId);
  const workspaceId = canonicalizeIdentifier(input.workspaceId);
  const learnerId = canonicalizeIdentifier(input.learnerId);

  let supersededLeaseId: string | null = null;
  let supersededLease: OfflineFlashcardLease | null = null;

  if (input.existingActiveLease) {
    const prior = input.existingActiveLease;
    if (!isPlainLeaseRecord(prior, EXISTING_LEASE_FIELDS, true)) return rejectUninspectableLeaseInput();
    if (
      canonicalizeIdentifier(prior.workspaceId) !== workspaceId ||
      canonicalizeIdentifier(prior.learnerId) !== learnerId
    ) {
      return {
        ok: false,
        code: "supersede_scope_mismatch",
        httpStatus: 409,
        message: "Cannot supersede an active lease belonging to a different workspace or learner.",
      };
    }
    if (canonicalizeIdentifier(prior.leaseId) === leaseId) {
      return {
        ok: false,
        code: "duplicate_lease_id",
        httpStatus: 409,
        message: "New leaseId must differ from the prior active leaseId.",
      };
    }
    if (prior.status === "active") {
      if (!isPlainLeaseArray(prior.cards)) return rejectUninspectableLeaseInput();
      const priorCards = inspectLeaseCards(prior.cards);
      if (!priorCards) return rejectUninspectableLeaseInput();
      supersededLeaseId = canonicalizeIdentifier(prior.leaseId);
      supersededLease = {
        ...prior,
        cards: priorCards,
        status: "superseded",
        supersededAtMs: input.issuedAtMs,
        supersededByLeaseId: leaseId,
      };
    }
  }

  const candidates = inspectLeaseCards(candidateList);
  if (!candidates) return rejectUninspectableLeaseInput();

  // Collect protected secrets across ALL candidates so every card (flashcard AND miss_variant)
  // is checked against both self and cross-card protected answers/sealed payloads.
  const protectedAnswers: ProtectedAnswerTexts = {
    texts: new Set(),
    arrayOptionLabels: new Set(),
    mathOptionGroups: [],
  };
  for (const candidate of candidates) {
    for (const forbiddenField of FORBIDDEN_MISS_VARIANT_FIELDS) {
      const property = Object.getOwnPropertyDescriptor(candidate, forbiddenField);
      if (!property) continue;
      const secretTexts = Object.hasOwn(property, "value") ? collectSecretTexts(property.value) : null;
      if (!secretTexts) {
        return {
          ok: false,
          code: "miss_variant_answer_leak",
          httpStatus: 422,
          cardId: isSafeIdentifier(candidate.cardId) ? candidate.cardId : undefined,
          message: `Offline lease refused: protected field ${forbiddenField} could not be fully inspected.`,
        };
      }
      for (const text of secretTexts.texts) protectedAnswers.texts.add(text);
      for (const label of secretTexts.arrayOptionLabels) protectedAnswers.arrayOptionLabels.add(label);
      for (const group of secretTexts.mathOptionGroups) protectedAnswers.mathOptionGroups.push(group);
    }
  }

  const seenCardIds = new Set<string>();
  const sanitizedCards: OfflineLeaseCard[] = [];
  for (const candidate of candidates) {
    const sanitized = sanitizeLeaseCandidate(candidate, protectedAnswers);
    if (!sanitized.ok) {
      return sanitized;
    }
    if (seenCardIds.has(sanitized.card.cardId)) {
      return {
        ok: false,
        code: "duplicate_card_id",
        httpStatus: 400,
        cardId: sanitized.card.cardId,
        message: `Duplicate cardId ${sanitized.card.cardId} in offline lease request.`,
      };
    }
    seenCardIds.add(sanitized.card.cardId);
    sanitizedCards.push(sanitized.card);
  }

  const lease: OfflineFlashcardLease = {
    schemaVersion: 1,
    leaseId,
    workspaceId,
    learnerId,
    status: "active",
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.issuedAtMs + OFFLINE_LEASE_TTL_MS,
    supersededAtMs: null,
    supersededByLeaseId: null,
    revokedAtMs: null,
    cards: sanitizedCards,
  };

  return {
    ok: true,
    lease,
    supersededLeaseId,
    supersededLease,
  };
}

export function revokeOfflineFlashcardLease(
  lease: OfflineFlashcardLease,
  revokedAtMs: number,
): OfflineFlashcardLease {
  if (lease.status !== "active") return lease;
  return {
    ...lease,
    status: "revoked",
    revokedAtMs,
  };
}

function scheduleServerReceiptFsrs(
  snapshot: ServerFlashcardSnapshot,
  effectiveRating: OfflineEffectiveRating,
  serverReceiptAtMs: number,
): ServerFlashcardSnapshot {
  const receiptDate = new Date(serverReceiptAtMs);
  const saved = snapshot.fsrs;
  const card: Card = saved
    ? {
        due: new Date(snapshot.dueAtMs),
        stability: saved.stability,
        difficulty: saved.difficulty,
        elapsed_days: saved.elapsedDays,
        scheduled_days: saved.scheduledDays,
        learning_steps: saved.learningSteps,
        reps: saved.reps,
        lapses: saved.lapses,
        state: saved.state,
        ...(saved.lastReviewAtMs !== null ? { last_review: new Date(saved.lastReviewAtMs) } : {}),
      }
    : createEmptyCard(receiptDate);

  const nextCard = FSRS_ENGINE.next(card, receiptDate, EFFECTIVE_RATING_TO_FSRS[effectiveRating]).card;
  const dueAtMs = nextCard.due.getTime();
  return {
    cardId: snapshot.cardId,
    revision: snapshot.revision + 1,
    lastServerReviewedAtMs: serverReceiptAtMs,
    dueAtMs,
    intervalDays: Math.max(0, Math.floor((dueAtMs - serverReceiptAtMs) / DAY_MS)),
    reps: snapshot.reps + 1,
    lapses: snapshot.lapses + (effectiveRating === "again" ? 1 : 0),
    lastGrade: effectiveRating,
    updatedAtMs: serverReceiptAtMs,
    fsrs: serializeFsrsCard(nextCard),
  };
}

function computeRawTrimmedOutboxPayloadFingerprint(entry: OfflineOutboxEntryInput): string {
  const trimmedEntry: OfflineOutboxEntryInput = {
    ...entry,
    leaseId: isNonEmptyString(entry.leaseId) ? entry.leaseId.trim() : entry.leaseId,
    cardId: isNonEmptyString(entry.cardId) ? entry.cardId.trim() : entry.cardId,
  };
  return sha256Utf8Hex(canonicalizeForFingerprint(trimmedEntry));
}

function buildPayloadSummary(entry: OfflineOutboxEntryInput): OfflineOutboxPayloadSummary {
  return {
    cardId: isNonEmptyString(entry.cardId) ? canonicalizeIdentifier(entry.cardId) : entry.cardId,
    rating: entry.rating,
    expectedCardRevision: entry.expectedCardRevision,
    clientReviewedAtMs: entry.clientReviewedAtMs ?? null,
  };
}

function payloadMatchesLedgerEntry(
  entry: OfflineOutboxEntryInput,
  canonicalFingerprint: string,
  ledgerEntry: OfflineOutboxLedgerEntry,
): boolean {
  const canonicalEntryLeaseId = isNonEmptyString(entry.leaseId)
    ? canonicalizeIdentifier(entry.leaseId)
    : entry.leaseId;
  const canonicalEntryCardId = isNonEmptyString(entry.cardId)
    ? canonicalizeIdentifier(entry.cardId)
    : entry.cardId;

  const rawTrimmedFingerprint = computeRawTrimmedOutboxPayloadFingerprint(entry);
  let fingerprintMatches =
    ledgerEntry.payloadFingerprint === canonicalFingerprint ||
    ledgerEntry.payloadFingerprint === rawTrimmedFingerprint;

  // Also support legacy pre-Round-7 stored ledger fingerprints whose original leaseId/cardId
  // used uppercase UUIDs while the replay arrives with canonical lowercase UUIDs (or vice versa).
  if (
    !fingerprintMatches &&
    canonicalizeIdentifier(ledgerEntry.leaseId) === canonicalEntryLeaseId &&
    canonicalizeIdentifier(ledgerEntry.receipt.cardId) === canonicalEntryCardId
  ) {
    const legacyCaseEntry: OfflineOutboxEntryInput = {
      ...entry,
      leaseId: ledgerEntry.leaseId,
      cardId: ledgerEntry.receipt.cardId,
    };
    const legacyCaseFingerprint = sha256Utf8Hex(canonicalizeForFingerprint(legacyCaseEntry));
    fingerprintMatches = ledgerEntry.payloadFingerprint === legacyCaseFingerprint;
  }

  if (!fingerprintMatches) return false;
  const summary = ledgerEntry.payloadSummary;
  if (summary) {
    if (
      canonicalizeIdentifier(summary.cardId) !== canonicalEntryCardId ||
      summary.rating !== entry.rating ||
      summary.expectedCardRevision !== entry.expectedCardRevision ||
      summary.clientReviewedAtMs !== (entry.clientReviewedAtMs ?? null)
    ) {
      return false;
    }
  }
  return (
    canonicalizeIdentifier(ledgerEntry.receipt.cardId) === canonicalEntryCardId &&
    ledgerEntry.receipt.rawRating === entry.rating &&
    ledgerEntry.receipt.previousRevision === entry.expectedCardRevision
  );
}

function detectStrippedClientFlags(entry: OfflineOutboxEntryInput): ReadonlyArray<string> {
  const record = entry as Record<string, unknown>;
  const stripped: string[] = [];
  for (const flag of STRIPPABLE_CLIENT_PROMOTION_FLAGS) {
    if (!Object.prototype.hasOwnProperty.call(record, flag)) continue;
    if (record[flag] !== undefined && record[flag] !== false && record[flag] !== null) {
      stripped.push(flag);
    }
  }
  return stripped;
}

/**
 * Reconciles an offline flashcard lease outbox batch with:
 * - strict lease liveness check evaluated at `serverReceiptAtMs` (never `clientReviewedAtMs`)
 * - idempotent `(leaseId, seq)` deduplication & `409 seq_payload_mismatch` fail-closed check
 * - `409 reviewed_elsewhere` desktop race protection
 * - FSRS scheduling strictly at `serverReceiptAtMs` with `"easy" -> "good"` cap
 * - zero `delayedCheck` / mastery / transfer promotion minting
 */
export function reconcileOfflineLeaseOutbox(
  input: ReconcileOfflineLeaseOutboxInput,
): ReconcileOfflineLeaseOutboxResult {
  const workingCards = toServerCardRecord(input.serverCards);
  const workingLedger = toLedgerRecord(input.processedLedger);
  const { lease, serverReceiptAtMs } = input;

  if (!isValidTimestamp(serverReceiptAtMs) || serverReceiptAtMs < lease.issuedAtMs) {
    return {
      ok: false,
      leaseStatus: "invalid_server_clock",
      httpStatus: 400,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: "serverReceiptAtMs must be a valid timestamp >= lease.issuedAtMs.",
    };
  }

  if (lease.status === "superseded") {
    return {
      ok: false,
      leaseStatus: "lease_superseded",
      httpStatus: 409,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: `Lease ${lease.leaseId} has been superseded by a newer lease.`,
    };
  }

  if (lease.status === "revoked") {
    return {
      ok: false,
      leaseStatus: "lease_revoked",
      httpStatus: 403,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: `Lease ${lease.leaseId} has been revoked.`,
    };
  }

  if (lease.status === "expired" || serverReceiptAtMs > lease.expiresAtMs) {
    return {
      ok: false,
      leaseStatus: "lease_expired",
      httpStatus: 410,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: `Lease ${lease.leaseId} expired at ${lease.expiresAtMs}; serverReceiptAtMs=${serverReceiptAtMs}.`,
    };
  }

  const canonicalLeaseId = canonicalizeIdentifier(lease.leaseId);
  const leasedCardById = new Map<string, OfflineLeaseCard>();
  for (const card of lease.cards) {
    if (!isSafeIdentifier(card.cardId)) continue;
    const canonicalCardId = canonicalizeIdentifier(card.cardId);
    if (leasedCardById.has(canonicalCardId)) {
      throw new TypeError(
        `Lease ${canonicalLeaseId} contains duplicate/conflicting canonical cardId "${canonicalCardId}".`,
      );
    }
    leasedCardById.set(canonicalCardId, card);
  }

  // Deterministic ordering: settle valid positive seq entries in ascending seq order
  // (ties preserve arrival order), while invalid seq entries fail closed deterministically.
  const orderedEntries = input.entries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .sort((a, b) => {
      const aValid = Number.isSafeInteger(a.entry.seq) && a.entry.seq >= 1;
      const bValid = Number.isSafeInteger(b.entry.seq) && b.entry.seq >= 1;
      if (aValid && bValid && a.entry.seq !== b.entry.seq) {
        return a.entry.seq - b.entry.seq;
      }
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    });

  const results: OfflineOutboxItemResult[] = [];
  // Each entry is checked against the active lease before in-batch deduplication.
  const seenSeqInBatch = new Map<
    number,
    { readonly payloadFingerprint: string; readonly payloadSummary: OfflineOutboxPayloadSummary }
  >();
  let settledCount = 0;
  let replayedCount = 0;
  let conflictCount = 0;

  for (const { entry } of orderedEntries) {
    if (!isSafeIdentifier(lease.leaseId) || !isSafeIdentifier(entry.leaseId)) {
      results.push({
        leaseId: entry.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "invalid_entry",
        httpStatus: 400,
        reason: "Outbox leaseId must be a safe non-empty identifier.",
      });
      continue;
    }

    const canonicalEntryLeaseId = canonicalizeIdentifier(entry.leaseId);

    if (canonicalEntryLeaseId !== canonicalLeaseId) {
      conflictCount += 1;
      results.push({
        leaseId: entry.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "lease_mismatch",
        httpStatus: 409,
        reason: `Outbox entry leaseId ${entry.leaseId} does not match active lease ${lease.leaseId}.`,
      });
      continue;
    }

    if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) {
      results.push({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "invalid_seq",
        httpStatus: 400,
        reason: "Outbox seq must be a positive safe integer (>= 1).",
      });
      continue;
    }

    if (!isSafeIdentifier(entry.cardId)) {
      results.push({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "invalid_entry",
        httpStatus: 400,
        reason: "Outbox cardId must be a safe non-empty identifier (reserved property keys are forbidden).",
      });
      continue;
    }

    const canonicalEntryCardId = canonicalizeIdentifier(entry.cardId);

    if (
      !isNonNegativeSafeInteger(entry.expectedCardRevision) ||
      !VALID_RAW_RATINGS.has(entry.rating) ||
      !isValidOptionalClientReviewedAtMs(entry.clientReviewedAtMs)
    ) {
      results.push({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        cardId: canonicalEntryCardId,
        outcome: "invalid_entry",
        httpStatus: 400,
        reason:
          "Outbox entry requires valid cardId, non-negative expectedCardRevision, valid rating, and finite or null clientReviewedAtMs.",
      });
      continue;
    }

    const payloadFingerprint = computeOfflineOutboxPayloadFingerprint(entry);
    const payloadSummary = buildPayloadSummary(entry);
    const idempotencyKey = offlineOutboxIdempotencyKey(canonicalLeaseId, entry.seq);
    const existingLedgerEntry = getOwnRecordProperty(workingLedger, idempotencyKey);

    // Idempotency check runs BEFORE desktop race checks so retries of already-settled
    // `(leaseId, seq)` entries return the cached receipt ONLY when the full payload
    // (fingerprint + cardId/rating/expectedCardRevision/clientReviewedAtMs) matches identically;
    // any mismatch fails closed with `409 seq_payload_mismatch`.
    if (existingLedgerEntry) {
      if (payloadMatchesLedgerEntry(entry, payloadFingerprint, existingLedgerEntry)) {
        replayedCount += 1;
        const cachedReceipt = cloneLedgerEntry(existingLedgerEntry).receipt;
        results.push({
          leaseId: canonicalLeaseId,
          seq: entry.seq,
          cardId: cachedReceipt.cardId,
          outcome: "replayed",
          httpStatus: 200,
          payloadFingerprint,
          effectiveRating: cachedReceipt.effectiveRating,
          clampedFromEasy: cachedReceipt.clampedFromEasy,
          authorityClock: "server_receipt",
          effectiveReviewedAtMs: cachedReceipt.effectiveReviewedAtMs,
          delayedCheckMinted: false,
          allowMasteryPromotion: false,
          transferVerified: false,
          receipt: cachedReceipt,
        });
      } else {
        conflictCount += 1;
        results.push({
          leaseId: canonicalLeaseId,
          seq: entry.seq,
          cardId: canonicalEntryCardId,
          outcome: "seq_payload_mismatch",
          httpStatus: 409,
          payloadFingerprint,
          expectedPayloadFingerprint: existingLedgerEntry.payloadFingerprint,
          reason: `Conflicting payload for (${canonicalLeaseId}, seq=${entry.seq}).`,
        });
      }
      continue;
    }

    const priorBatchSeq = seenSeqInBatch.get(entry.seq);
    if (priorBatchSeq) {
      if (priorBatchSeq.payloadFingerprint !== payloadFingerprint) {
        conflictCount += 1;
        results.push({
          leaseId: canonicalLeaseId,
          seq: entry.seq,
          cardId: canonicalEntryCardId,
          outcome: "seq_payload_mismatch",
          httpStatus: 409,
          payloadFingerprint,
          expectedPayloadFingerprint: priorBatchSeq.payloadFingerprint,
          reason: `Conflicting in-batch reuse of (${canonicalLeaseId}, seq=${entry.seq}).`,
        });
        continue;
      }
    } else {
      seenSeqInBatch.set(entry.seq, { payloadFingerprint, payloadSummary });
    }

    const leasedCard = leasedCardById.get(canonicalEntryCardId);
    if (!leasedCard) {
      results.push({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        cardId: canonicalEntryCardId,
        outcome: "card_not_in_lease",
        httpStatus: 403,
        reason: `Card ${canonicalEntryCardId} is not covered by lease ${canonicalLeaseId}.`,
      });
      continue;
    }

    const serverCard = getOwnRecordProperty(workingCards, canonicalEntryCardId);
    if (!serverCard) {
      results.push({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        cardId: canonicalEntryCardId,
        outcome: "card_not_found",
        httpStatus: 404,
        reason: `Server card snapshot ${canonicalEntryCardId} was not found.`,
      });
      continue;
    }

    // Compare live serverCard.revision and client expectedCardRevision against the
    // authoritative leasedCard.cardRevision snapshot minted into the lease (never trust
    // a client claiming a newer revision to overwrite a same-millisecond desktop review).
    const fsrsLastReviewAtMs = serverCard.fsrs?.lastReviewAtMs ?? null;
    const serverMovedFromLease = serverCard.revision !== leasedCard.cardRevision;
    const expectedRevisionMismatch =
      entry.expectedCardRevision !== leasedCard.cardRevision ||
      serverCard.revision !== entry.expectedCardRevision;
    const serverReviewedSinceLease =
      serverCard.lastServerReviewedAtMs !== null &&
      (serverCard.lastServerReviewedAtMs > lease.issuedAtMs ||
        (serverCard.lastServerReviewedAtMs >= lease.issuedAtMs &&
          (serverMovedFromLease ||
            serverCard.lastServerReviewedAtMs !== leasedCard.lastServerReviewedAtMs)));
    const fsrsReviewedSinceLease =
      fsrsLastReviewAtMs !== null &&
      (fsrsLastReviewAtMs > lease.issuedAtMs ||
        (fsrsLastReviewAtMs >= lease.issuedAtMs &&
          (serverMovedFromLease || fsrsLastReviewAtMs !== leasedCard.lastServerReviewedAtMs)));
    const reviewAheadOfServerClock =
      fsrsLastReviewAtMs !== null && fsrsLastReviewAtMs > serverReceiptAtMs;

    if (
      serverMovedFromLease ||
      expectedRevisionMismatch ||
      serverReviewedSinceLease ||
      fsrsReviewedSinceLease ||
      reviewAheadOfServerClock
    ) {
      conflictCount += 1;
      results.push({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        cardId: canonicalEntryCardId,
        outcome: "reviewed_elsewhere",
        httpStatus: 409,
        serverRevision: serverCard.revision,
        leasedCardRevision: leasedCard.cardRevision,
        expectedCardRevision: entry.expectedCardRevision,
        serverLastReviewedAtMs: serverCard.lastServerReviewedAtMs,
        reason: `Card ${canonicalEntryCardId} was reviewed elsewhere (serverRevision=${serverCard.revision}, leasedRevision=${leasedCard.cardRevision}, expected=${entry.expectedCardRevision}).`,
      });
      continue;
    }

    const clampedFromEasy = entry.rating === "easy";
    const effectiveRating: OfflineEffectiveRating = clampedFromEasy ? "good" : entry.rating;
    const nextSnapshot = scheduleServerReceiptFsrs(serverCard, effectiveRating, serverReceiptAtMs);
    const strippedClientFlags = detectStrippedClientFlags(entry);

    const receipt: OfflineSettledReceipt = {
      leaseId: canonicalLeaseId,
      seq: entry.seq,
      cardId: canonicalEntryCardId,
      rawRating: entry.rating,
      effectiveRating,
      clampedFromEasy,
      authorityClock: "server_receipt",
      effectiveReviewedAtMs: serverReceiptAtMs,
      delayedCheckMinted: false,
      allowMasteryPromotion: false,
      transferVerified: false,
      strippedClientFlags,
      previousRevision: serverCard.revision,
      newRevision: nextSnapshot.revision,
      nextSnapshot,
    };

    setOwnRecordProperty(workingCards, canonicalEntryCardId, nextSnapshot);
    setOwnRecordProperty(workingLedger, idempotencyKey, {
      leaseId: canonicalLeaseId,
      seq: entry.seq,
      payloadFingerprint,
      payloadSummary,
      receipt: cloneLedgerEntry({
        leaseId: canonicalLeaseId,
        seq: entry.seq,
        payloadFingerprint,
        payloadSummary,
        receipt,
      }).receipt,
    });
    settledCount += 1;

    results.push({
      leaseId: canonicalLeaseId,
      seq: entry.seq,
      cardId: canonicalEntryCardId,
      outcome: "settled",
      httpStatus: 200,
      payloadFingerprint,
      effectiveRating,
      clampedFromEasy,
      authorityClock: "server_receipt",
      effectiveReviewedAtMs: serverReceiptAtMs,
      delayedCheckMinted: false,
      allowMasteryPromotion: false,
      transferVerified: false,
      receipt,
    });
  }

  return {
    ok: true,
    leaseStatus: "active",
    serverReceiptAtMs,
    settledCount,
    replayedCount,
    conflictCount,
    results,
    updatedServerCards: workingCards,
    nextProcessedLedger: workingLedger,
  };
}
