import { describe, expect, it } from "vitest";
import { renderLearnerContextBlock } from "./v3-bitemporal-misconception-memory";

describe("LearnerContextBlock rendering", () => {
  it("fits multibyte text into the UTF-8 budget without truncating a code point", () => {
    const result = renderLearnerContextBlock([
      { status: "candidate", learnerDisposition: null, summary: "汉🧠".repeat(1000) },
    ]);
    expect(result.byteLength).toBe(Buffer.byteLength(result.renderedMarkdown));
    expect(result.byteLength).toBeGreaterThanOrEqual(2045);
    expect(result.byteLength).toBeLessThanOrEqual(2048);
    expect(result.renderedMarkdown).toMatch(/^- 待确认：(?:汉🧠)+汉?$/u);
  });

  it("renders source labels and keeps user Markdown on a single literal line", () => {
    expect(renderLearnerContextBlock([
      { status: "learner_reported", learnerDisposition: "disputed", summary: "原判断有误\n# <tag>" },
      { status: "verified", learnerDisposition: null, summary: "复核结果" },
    ]).renderedMarkdown).toBe("- 学习者提出异议：原判断有误 \\# \\<tag\\>\n- 已确认：复核结果");
  });
});
