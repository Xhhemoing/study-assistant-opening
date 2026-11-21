import { describe, expect, it } from "vitest";
import { equationMarkdownBlocks } from "./equation-markdown";
import { detectProtectedLeakage } from "./evaluator";

describe("Markdown paragraph and table boundaries in the equation audit", () => {
  it.each([
    ["$", "$"], ["$$", "$$"], ["\\(", "\\)"], ["\\[", "\\]"],
    ["\\begin{align}", "\\end{align}"],
  ])("recognizes a closing %s only outside TeX comments", (open, close) => {
    const start = "At 50% use " + open + "y = 2 \\\\[1ex]% ";
    const end = "\ny = 3 \\\\[1ex]x &= 4" + close;
    expect(detectProtectedLeakage(start + close + end, ["x = 4"], [])).toEqual(["x = 4"]);
    expect(detectProtectedLeakage(start + close + " ; x = 4\nz = 3" + close, ["x = 4"], [])).toEqual([]);
    const escapedPercent = open + "y = 100\\% \\\\[1ex]x &= 4" + close;
    expect(detectProtectedLeakage(escapedPercent, ["x = 4"], [])).toEqual(["x = 4"]);
  });

  it("pairs the visible nested environments even when the opener follows a prose percentage", () => {
    const body = [
      " % \\end{align}", "\\begin{align}", "% \\begin{align} \\end{align}",
      "x &= 4", "\\end{align}", "- x = 4", "",
    ].join("\n");
    const text = "At 50% use \\begin{align}" + body + "\\end{align} done.";
    expect(equationMarkdownBlocks(text)).toEqual(["At 50% use ", { math: body }, " done."]);
  });

  it("keeps a display opener in an inline math comment from masking a following bullet", () => {
    const hint = "Read $y % \\begin{align}\nz$.\n- **x = 4**\n\\end{align}";
    expect(detectProtectedLeakage(hint, ["x = 4"], [])).toEqual(["x = 4"]);
  });

  it("consumes only the backslash that escapes a pipe in a table cell", () => {
    const row = [String.raw`a\|b`, "c" + "\\".repeat(2), String.raw`d\\\|e`].join("|");
    expect(equationMarkdownBlocks("one|two|three\n-:|:-|:-:\n" + row)).toEqual([
      ["one", "two", "three"], [], ["a|b", "c" + "\\".repeat(2), "d" + "\\".repeat(2) + "|e"],
    ]);
  });

  it.each(["--- | --- | ---", "--- | typo"])("leaves an invalid table delimiter in prose: %s", (delimiter) => {
    expect(equationMarkdownBlocks("a | b\n" + delimiter)).toEqual(["a | b\n" + delimiter]);
  });

  it.each([
    ["2. continuation", true],
    ["3) continuation", true],
    ["1.  ", true],
    ["*   ", true],
    ["+", true],
    ["-   ", false],
    ["    indented continuation", true],
    ["<span>", true],
    ["# Heading", false],
    ["> quote", false],
    ["---", false],
    ["* * *", false],
    ["<div>", false],
    ["1. new item", false],
    ["- new item", false],
  ] as const)("resolves a code span around %j", (middle, continues) => {
    const hint = ["Text `unpaired", middle, "$$", "marker`", "- x = 4", "$$"].join("\n");
    expect(detectProtectedLeakage(hint, ["x = 4"], [])).toEqual(continues ? ["x = 4"] : []);
  });

  it.each([
    ["soft break in inline code", "Read `x =\n4`.", true],
    ["soft break in emphasis", "Read **x =\n4**.", true],
    ["soft break in prose", "Read x =\n4.", true],
    ["soft break in inline math", "Read $x =\n4$.", true],
    ["physical equation start after a digit", "Step 2\nx = 4", true],
    ["separate paragraphs", "Read x =\n\n4.", false],
    ["an explicit hard break", "Read x =  \n4.", false],
    ["a backslash hard break", "Read x =\\\n4.", false],
    ["spaces before a newline in a code span", "Read `x =  \n4`.", true],
    ["a soft break preserves a unary sign", "Read `-\nx = 4`.", false],
    ["a soft break preserves the denominator", "Read x = 4\n/5.", false],
    ["a signed right operand spans a soft break", "Read **x =\n-4**.", false],
    ["lazy quote with an ordered marker", "> Literal `start\n2. continuation\n> $$ marker`\n>\n> - **x = 4**\n>\n> $$", true],
    ["a standalone display marker shielded by lazy quote code", "> Literal `start\n2. continuation\n> $$\n> marker`\n>\n> - **x = 4**\n>\n> $$", true],
    ["an empty lazy marker inside a quoted span", "> Literal `start\n-\n> $$\n> marker`\n>\n> - **x = 4**\n>\n> $$", true],
    ["two ordered sibling items have independent paragraphs", "3. Read x =\n4. more", false],
    ["inline dollars across a blank line", "Text $$ marker\n\n- **x = 4**\n\n$$", true],
    ["inline parentheses across a list", "Text \\(marker\n- **x = 4**\n\\)", true],
    ["a formatted bullet ending with a stray inline closer", "Text \\(marker\n- **x = 4** \\)", true],
    ["a formatted bullet with its own math", "Text \\(marker\n- `x = 4` then \\(y\\)", true],
    ["inline dollars across a heading", "Text $marker\n# title\n- **x = 4**\n$", true],
    ["loose inline dollars on separate list items", "Text $$ marker\n- **x = 4** $$", true],
    ["table-looking display body", "$$\na | b\n--- | ---\n- x = 4\n$$", false],
    ["setext-looking display body", "$$\na\n---\n- x = 4\n$$", false],
    ["bracketed display containing table syntax", "\\[\na | b\n--- | ---\n- x = 4\n\\]", false],
    ["bracketed display starting after prose", "The formula is \\[\na | b\n--- | ---\n- x = 4\n\\]", false],
    ["a display marker inside inline code", "Use `\\[` literally.\n- **x = 4**\n\\]", true],
    ["a later unquoted display marker", "Use `\\[` then \\[\na | b\n--- | ---\n- x = 4\n\\]", false],
    ["environment containing an underline", "\\begin{align}\ny\n---\n- x = 4\n\\end{align}", false],
    ["a Markdown fence is literal inside a display", "$$\n```text\n- x = 4\n```\n- x = 4\n$$", false],
    ["display closer among apparent table rows", "$$\na | b\n--- | ---\n$$\n- **x = 4**", true],
    ["a closed display ends the apparent table before following inline code", "$$\nh|n\n-|-\n$$\nLiteral `x\n$$\nend`\n\n- **x = 4**\n\n$$", true],
    ["display after the real table has ended", "h | n\n-|-\n`$$`|x\n\n$$\ny\n---\n- x = 4\n$$", false],
    ["unmatched math in a header cannot close after its cell", "| $$ | value |\n| --- | --- |\n\n- **x = 4**\n\n$$", true],
    ["an answer split between cells is absent", "a | b\n---|---\nx = | 4", false],
    ["a genuine cell keeps its unary minus", "a | b\n---|---\ncode | `- x = 4`", false],
    ["a complete equation is visible within a cell", "a | b\n---|---\n` | **`x = 4`**", true],
    ["a signed right-hand side remains distinct", "a | b\n---|---\nx = -4 | next", false],
    ["a list fence preserves its sign", "3) ```text\n   - x = 4\n   ```", false],
    ["a lazy blockquote continuation keeps the code span open", "> Literal `start\nlazy continuation\n> $$ marker`\n>\n> - **x = 4**\n>\n> $$", true],
    ["a quote delimiter row requires its quote prefix", "> Literal `start\nlazy | header\n--- | ---\n> $$ marker`\n>\n> - **x = 4**\n>\n> $$", true],
    ["an indented line inside display math preserves a later sign", "$$\n\n    y = 0\n- x = 4\n$$", false],
    ["list padding can introduce indented code", "-     - x = 4", false],
  ] as const)("%s", (_name, hint, leaks) => {
    expect(detectProtectedLeakage(hint, ["x = 4"], [])).toEqual(leaks ? ["x = 4"] : []);
  });
});
