import { describe, expect, it } from "vitest";
import {
  escapeLatexInJsonStrings,
  LATEX_COMMANDS_COLLIDING_WITH_JSON_ESCAPES,
  parseModelJson,
  repairDecodedLatexEscapes,
  repairDecodedLatexInJson,
} from "./latex-json";

describe("parseModelJson", () => {
  it("keeps LaTeX commands that collide with JSON escapes", () => {
    const parsed = parseModelJson('{"text":"$(-2)\\times(-3)=6$, $\\frac{1}{2}$, $\\beta \\neq \\rho$, $\\right)$"}') as { text: string };
    expect(parsed.text).toBe("$(-2)\\times(-3)=6$, $\\frac{1}{2}$, $\\beta \\neq \\rho$, $\\right)$");
  });
  it("does not throw on invalid escapes such as \\cdot or \\sqrt", () => {
    const parsed = parseModelJson('{"text":"$a\\cdot b = \\sqrt{x} \\le \\{1\\}$"}') as { text: string };
    expect(parsed.text).toBe("$a\\cdot b = \\sqrt{x} \\le \\{1\\}$");
  });
  it("preserves real JSON escapes", () => {
    const parsed = parseModelJson('{"text":"line1\\nline2\\t\\"q\\" \\\\ \\u4e2d \\n第二行"}') as { text: string };
    expect(parsed.text).toBe('line1\nline2\t"q" \\ 中 \n第二行');
  });
  it("leaves already doubled LaTeX alone", () => {
    expect(escapeLatexInJsonStrings('{"a":"\\\\times"}')).toBe('{"a":"\\\\times"}');
  });
  it("does not touch text outside strings", () => {
    expect(escapeLatexInJsonStrings('{"a": 1}')).toBe('{"a": 1}');
  });
});

describe("repairDecodedLatexEscapes", () => {
  // What a plain JSON.parse made of single-backslash model LaTeX.
  const corrupted = (raw: string) => JSON.parse(`"${raw}"`) as string;

  it("restores every command the old JSON.parse decoded into a control character", () => {
    const stored = corrupted("$(-2)\\times(-3)=6$, $\\frac{1}{2}$, $\\beta \\neq \\rho$, $(x\\right)$");
    expect(stored).toContain("\t" + "imes");
    const { text, repairs } = repairDecodedLatexEscapes(stored);
    expect(text).toBe("$(-2)\\times(-3)=6$, $\\frac{1}{2}$, $\\beta \\neq \\rho$, $(x\\right)$");
    expect(repairs).toBe(6);
  });

  it("repairs the whole word only and keeps what follows", () => {
    expect(repairDecodedLatexEscapes("$\theta_1 + \tau^2 \text{m} \to 9$").text)
      .toBe("$\\theta_1 + \\tau^2 \\text{m} \\to 9$");
    expect(repairDecodedLatexEscapes("$x \rightarrow 0, \forall \bar{x}$").text)
      .toBe("$x \\rightarrow 0, \\forall \\bar{x}$");
  });

  it("keeps real line breaks and tabs in prose", () => {
    const prose = "第一步\n第二步\n\te.g. 例子\nnote: u = 1\n\tan apple\nmid-term\n";
    expect(repairDecodedLatexEscapes(prose)).toEqual({ text: prose, repairs: 0 });
    expect(repairDecodedLatexEscapes("line\r\nnext")).toEqual({ text: "line\r\nnext", repairs: 0 });
  });

  it("repairs short or prose-like commands inside math only", () => {
    expect(repairDecodedLatexEscapes("$a \ne b$, $\nu$, $x \to 1$, $$\tan x$$").text)
      .toBe("$a \\ne b$, $\\nu$, $x \\to 1$, $$\\tan x$$");
    expect(repairDecodedLatexEscapes("outside \ne b").repairs).toBe(0);
    expect(repairDecodedLatexEscapes("outside a \neq b and \times 2").text).toBe("outside a \\neq b and \\times 2");
  });

  it("does not touch unknown words or already intact LaTeX", () => {
    expect(repairDecodedLatexEscapes("$\\times$ \tfoo \nbar")).toEqual({ text: "$\\times$ \tfoo \nbar", repairs: 0 });
    expect(repairDecodedLatexEscapes("")).toEqual({ text: "", repairs: 0 });
  });

  it("is idempotent", () => {
    const once = repairDecodedLatexEscapes(corrupted("$\\frac{a}{b} \\times \\beta$")).text;
    expect(repairDecodedLatexEscapes(once)).toEqual({ text: once, repairs: 0 });
  });

  it("exports the shared command list used by parseModelJson", () => {
    expect(LATEX_COMMANDS_COLLIDING_WITH_JSON_ESCAPES.has("times")).toBe(true);
    expect(LATEX_COMMANDS_COLLIDING_WITH_JSON_ESCAPES.has("cdot")).toBe(false);
  });
});

describe("repairDecodedLatexInJson", () => {
  it("repairs nested string values, never keys, and returns the input when nothing changed", () => {
    const evaluation = { feedback: "$\frac{1}{2}$", criteria: [{ label: "\times", feedback: "ok" }], confidence: 0.5, "\tab": "x" };
    const { value, repairs } = repairDecodedLatexInJson(evaluation);
    expect(repairs).toBe(2);
    expect(value).toEqual({ feedback: "$\\frac{1}{2}$", criteria: [{ label: "\\times", feedback: "ok" }], confidence: 0.5, "\tab": "x" });
    const clean = { a: ["$\\times$"] };
    expect(repairDecodedLatexInJson(clean).value).toBe(clean);
  });
});
