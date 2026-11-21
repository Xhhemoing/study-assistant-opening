import { describe, expect, it } from "vitest";
import { equationMarkdownLines } from "./equation-markdown";
import { detectProtectedLeakage } from "./evaluator";

describe("Markdown paragraph and table boundaries in the equation audit", () => {
  it("consumes only the backslash that escapes a pipe in a table cell", () => {
    const row = [String.raw`a\|b`, "c" + "\\".repeat(2), String.raw`d\\\|e`].join("|");
    expect(equationMarkdownLines("one|two|three\n-:|:-|:-:\n" + row)).toEqual([
      ["one", "two", "three"], [], ["a|b", "c" + "\\".repeat(2), "d" + "\\".repeat(2) + "|e"],
    ]);
  });

  it.each(["--- | --- | ---", "--- | typo"])("leaves an invalid table delimiter in prose: %s", (delimiter) => {
    expect(equationMarkdownLines("a | b\n" + delimiter)).toEqual(["a | b", delimiter]);
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
    const hint = ["Text `unpaired", middle, "$$ marker`", "- x = 4", "$$"].join("\n");
    expect(detectProtectedLeakage(hint, ["x = 4"], [])).toEqual(continues ? ["x = 4"] : []);
  });

  it.each([
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
