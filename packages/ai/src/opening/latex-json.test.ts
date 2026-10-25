import { describe, expect, it } from "vitest";
import { escapeLatexInJsonStrings, parseModelJson } from "./latex-json";

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
