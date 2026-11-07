import { describe, expect, it } from "vitest";
import { evaluateTeachingAnswer as check } from "./teaching-answer-check";
const numeric = { kind: "numeric" as const };
const choice = { kind: "choice" as const, options: [{ id: "A", label: "1/2" }, { id: "B", label: "7/12" }, { id: "C", label: "3" }] };
const question = "计算 1/3 + 1/4?";
describe("teaching answer exactness", () => {
  it.each([["-1/2", "incorrect"], ["\\frac{7}{12}", "correct"], ["14/24", "correct"], ["0.5", "unparseable"], ["1+1", "unparseable"], ["π", "unparseable"], ["2米", "unparseable"], ["1 2", "unparseable"]] as const)("numeric %s", (answer, expected) => expect(check(question, numeric, "7/12", answer)).toBe(expected));
  it("accepts exact finite decimals", () => expect(check("1/4+1/4", numeric, "1/2", "0.50")).toBe("correct"));
  it.each(["B", "B.", "(B)", "（B）", "7/12", "Answer: 7/12"])("accepts consistent key %s", key => expect(check(question, choice, key, "B. 7/12")).toBe("correct"));
  it.each(["A", "选 B", "2", "", "garbage"])("rejects key %s", key => expect(check(question, choice, key, "B. 7/12")).toBeNull());
  it.each([["A. 1/2", "incorrect"], ["Z. 7/12", "unparseable"], ["B", "unparseable"], ["B.7/12", "unparseable"]] as const)("choice %s", (answer, expected) => expect(check(question, choice, "B", answer)).toBe(expected));
  it("requires one matching option and supported interaction and key", () => {
    expect(check(question, { kind: "choice", options: [{ id: "A", label: "1" }, { id: "B", label: "2" }] }, "B", "B. 2")).toBeNull();
    expect(check(question, { kind: "choice", options: [{ id: "A", label: "7/12" }, { id: "B", label: "14/24" }] }, "B", "B. 14/24")).toBeNull();
    expect(check(question, { kind: "numeric", unit: "m" }, "7/12", "7/12")).toBeNull();
    expect(check(question, undefined, "7/12", "7/12")).toBeNull();
    expect(check(question, numeric, null, "7/12")).toBeNull();
    expect(check(question, numeric, "2", "7/12")).toBeNull();
    expect(check(question, numeric, "unknown", "7/12")).toBeNull();
    expect(check("单数 2", numeric, "2", "2")).toBeNull();
  });
});

describe("numeric answer boundaries", () => {
  it.each([
    ["计算 1-3", "-2", " -2 ", "correct"],
    ["计算 1/4-3/4", "-1/2", "-\\frac{2}{4}", "correct"],
    ["计算 1/4-3/4", "-1/2", "-0.50", "correct"],
    ["计算 2-2", "0", "-0", "correct"],
    ["计算 2+3", "5", "5", "correct"],
    ["计算 1/8+1/8", "1/4", ".25", "correct"],
    ["计算 1/8+1/8", "1/4", "0.2", "incorrect"],
    ["计算 1/3+1/6", "1/2", "0.5", "correct"],
    ["计算 1/6+1/6", "1/3", "2/6", "correct"],
    ["计算 1/6+1/6", "1/3", "0.3333333333333333", "unparseable"],
  ] as const)("grades %s with %s as %s", (prompt, key, answer, outcome) => {
    expect(check(prompt, numeric, key, answer)).toBe(outcome);
  });

  it.each([
    "", " ", "+1", "--1", "(1)", "1/2+1/12", "7 / 12", "7/-12", "1/0",
    "\\frac{1}{0}", "2*3", "π/2", "√2", "sqrt(2)", "x", "7/12米", "7/12 1", "1,2", "1e0",
  ])("does not interpret a nonliteral submission %j", answer => {
    expect(check(question, numeric, "7/12", answer)).toBe("unparseable");
  });

  it.each([null, "", "   ", "2", "选 B"])("requires a corroborated numeric key %j", key => {
    expect(check(question, numeric, key, "7/12")).toBeNull();
  });

  it.each(["", " ", "m"])("rejects a declared numeric unit %j", unit => {
    expect(check(question, { kind: "numeric", unit }, "7/12", "7/12")).toBeNull();
  });

  it.each(["2", "计算 2", "求 x: x+1=2", "计算 1/0", "计算 1米+2米"])("does not control unsupported question %s", prompt => {
    expect(check(prompt, numeric, "2", "2")).toBeNull();
    expect(check(prompt, choice, "B", "B. 7/12")).toBeNull();
  });
});

describe("choice answer and key boundaries", () => {
  it.each(["B． 7/12", "B、 7/12", "B: 7/12", "B：7/12", "B, 7/12", "B，7/12", " B \n", "(B). 7/12"])("recognizes saved key id with boundary %j", key => {
    expect(check(question, choice, key, "B. 7/12")).toBe("correct");
  });

  it.each(["b", "BB", "B7/12", "(B)7/12", "选 B", "选 B，因为答案为7/12", "Answer: 1/2", "7/12=1/2", null, " "])("does not authorize inconsistent or unsupported key %j", key => {
    expect(check(question, choice, key, "B. 7/12")).toBeNull();
  });

  it.each(["A. 7/12", "A: 7/12", "（A） 7/12"])("does not override the wrong saved key id with a correct value %s", key => {
    expect(check(question, choice, key, "B. 7/12")).toBeNull();
  });

  it("accepts a checked equality key without a saved id prefix", () => {
    expect(check(question, choice, "答案：1/3+1/4=7/12", "B. 7/12")).toBe("correct");
  });

  it.each(["", "b. 7/12", " B. 7/12", "B． 7/12", "B: 7/12", "B . 7/12", "7/12"])("rejects a malformed or unsaved submission id %j", answer => {
    expect(check(question, choice, "B", answer)).toBe("unparseable");
  });

  it("requires the entire submitted option to match its saved id and label", () => {
    expect(check(question, choice, "B", "B. 1/2. other text")).toBe("unparseable");
    expect(check(question, choice, "B", "A. 7/12")).toBe("unparseable");
    expect(check(question, choice, "B", "B. 1/2")).toBe("unparseable");
  });

  it("uses the full submitted option when an id contains the delimiter", () => {
    const options = [{ id: "B", label: "2" }, { id: "B. 1", label: "3" }];
    // The submission uniquely identifies B. 1, whose value is incorrect.
    expect(check("1+1", { kind: "choice", options }, "B", "B. 1. 3")).toBe("incorrect");
  });

  it("does not control submissions matching multiple complete options", () => {
    const options = [{ id: "B", label: "1. 3" }, { id: "B. 1", label: "3" }, { id: "C", label: "2" }];
    expect(check("1+1", { kind: "choice", options }, "C", "B. 1. 3")).toBeNull();
  });

  it("rejects overlapping key ids regardless of option order", () => {
    const options = [{ id: "B", label: "2" }, { id: "B.1", label: "3" }];
    for (const ordered of [options, [...options].reverse()]) {
      expect(check("1+1", { kind: "choice", options: ordered }, "B.1", "B. 2")).toBeNull();
    }
  });

  it("rejects overlapping closing-parenthesis key ids regardless of option order", () => {
    const options = [{ id: "A", label: "2" }, { id: "A)", label: "3" }];
    for (const ordered of [options, [...options].reverse()]) {
      expect(check("1+1", { kind: "choice", options: ordered }, "(A)", "A. 2")).toBeNull();
    }
  });

  it("only matches option labels that are single numeric literals", () => {
    const options = [{ id: "A", label: "1/3+1/4" }, { id: "B", label: "7/12米" }];
    expect(check(question, { kind: "choice", options }, "7/12", "A. 1/3+1/4")).toBeNull();
  });

  it("matches fractional, signed and decimal option literals by exact value", () => {
    expect(check("计算 1/4-3/4", {
      kind: "choice", options: [{ id: "A", label: "-0.50" }, { id: "B", label: "1/2" }],
    }, "A", "A. -0.50")).toBe("correct");
    expect(check(question, {
      kind: "choice", options: [{ id: "A", label: "\\frac{14}{24}" }, { id: "B", label: "1/2" }],
    }, "A", "A. \\frac{14}{24}")).toBe("correct");
  });

  it("rejects multiple exact matches even when their literal forms differ", () => {
    expect(check("计算 1/4+1/4", {
      kind: "choice", options: [{ id: "A", label: "2/4" }, { id: "B", label: "0.50" }],
    }, "A", "A. 2/4")).toBeNull();
  });

  it("matches a complete saved id instead of an overlapping shorter id", () => {
    expect(check(question, {
      kind: "choice", options: [{ id: "B", label: "1/2" }, { id: "BB", label: "7/12" }],
    }, "(BB)", "BB. 7/12")).toBe("correct");
  });
});

describe("meaning after Markdown rendering", () => {
  const products = { kind: "choice" as const, options: [{ id: "A", label: "10" }, { id: "B", label: "127" }] };
  const optionA = (label: string) => ({ kind: "choice" as const, options: [{ id: "A", label }, { id: "B", label: "99" }] });

  it.each(["A. 10", "B. 127"])("does not grade %s when emphasis hides the multiplication signs", answer => {
    expect(check("1*2*3+4", products, "10", answer)).toBeNull();
  });

  it("grades the same product written as inline math", () => {
    expect(check("$1*2*3+4$", products, "10", "A. 10")).toBe("correct");
  });

  it("does not trust inline math split by a blank line", () => {
    expect(check("$1\n\n*2*3+4$", products, "10", "A. 10")).toBeNull();
  });

  it("does not grade a numeric answer when emphasis hides the multiplication signs", () => {
    expect(check("1*2*3+4", numeric, "10", "10")).toBeNull();
  });

  it.each([
    ["- 3 + 4", "1"], ["3\n-\n2", "1"], ["(1+\n1) - 1", "1"], ["3\n---\n2", "1"], ["3\n-- --\n2", "5"],
  ])("does not grade %j when a list, heading or rule hides an operator", (prompt, value) => {
    expect(check(prompt, optionA(value), value, `A. ${value}`)).toBeNull();
  });

  it.each(["$10$", "*10*"])("does not grade when option %j does not render as its saved number", label => {
    const interaction = { kind: "choice" as const, options: [{ id: "A", label: "10" }, { id: "B", label }] };
    expect(check("5+5", interaction, "10", "A. 10")).toBeNull();
    expect(check("5+5", interaction, "10", `B. ${label}`)).toBeNull();
  });
});
