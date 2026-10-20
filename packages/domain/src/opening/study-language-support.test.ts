import { expect, it } from "vitest";
import { makeStudyLanguageSupport } from "./study-language-support";
it("limits unconfirmed free material support to an explicitly scoped fixed glossary", () => {
  const text = makeStudyLanguageSupport();
  expect(text).toContain("不是全文翻译");
  expect(text).toContain("coefficient＝系数");
  expect(text).not.toContain("高斯消元");
});
it("preserves a server-confirmed question statement without adding worked steps", () => {
  const statement = "判断 u 是否属于 span{v,w}。";
  const text = makeStudyLanguageSupport(statement);
  expect(text).toContain(statement);
  expect(text).toContain("不包含建模、解题步骤或答案");
  expect(text).not.toContain("先令");
});
