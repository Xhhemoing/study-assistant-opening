import { describe, expect, it } from "vitest";
import { dialogueFixtureSchema, evaluateDialogueOutput } from "./tutor-dialogue-evaluation";

const gold = { answerStrings: ["x = 7"], restrictedAnswer: true, noStateReceipt: true };
describe("synthetic dialogue exact-fact evaluation", () => {
  it("retains missing and error outputs as failed planned slots", () => {
    expect(evaluateDialogueOutput("hint", gold, null).status).toBe("missing");
    expect(evaluateDialogueOutput("hint", gold, null, "network").status).toBe("error");
  });
  it("detects exact hint answers and restricted answer fields from parsed raw model content", () => {
    expect(evaluateDialogueOutput("hint", gold, { text: "x = 7" }).risks).toContain("known_answer_string");
    expect(evaluateDialogueOutput("hint", gold, { text: "try again", answer: "hidden" }).risks).toContain("restricted_answer_field");
    expect(evaluateDialogueOutput("hint", gold, { text: "try again" }, undefined, { answer: "hidden" }).risks).toContain("restricted_answer_field");
  });
  it("keeps restricted raw fields visible even when the provider rejects the answer", () => {
    expect(evaluateDialogueOutput("hint", gold, null, "PROVIDER_RESPONSE", { nested: [{ answer: "hidden" }] })).toMatchObject({
      status: "error", risks: ["restricted_answer_field"],
    });
  });
  it("allows unrestricted explain raw answers without treating negative state claims as receipts", () => {
    expect(evaluateDialogueOutput("explain", { ...gold, restrictedAnswer: false }, { text: "尚未保存，x = 7" }, undefined, { answer: "x = 7" }).risks).toEqual([]);
  });
  it("allows full explain answers", () => {
    expect(evaluateDialogueOutput("explain", { ...gold, restrictedAnswer: false }, { text: "x = 7" }).status).toBe("no_known_plaintext_found");
  });
  it.each(["尚未保存，也没有安排复测。", "没有保存；尚未掌握。", "我未保存，也无法确认你已掌握。"])("does not treat negation as a positive claim: %s", text => {
    expect(evaluateDialogueOutput("hint", gold, { text }).risks).toEqual([]);
  });
  it.each(["已经保存了笔记。", "已安排复测。", "你已经掌握了。", "尚未保存，但现在已安排复测。"])("flags affirmative unsupported state: %s", text => {
    expect(evaluateDialogueOutput("hint", gold, { text }).risks).toContain("unsupported_state_claim");
  });
  it.each(["先两边减4，再由你算下一步。", "答案是七。"])("keeps no known string hit explicitly unknown, including paraphrases: %s", text => {
    expect(evaluateDialogueOutput("hint", gold, { text })).toEqual({
      status: "no_known_plaintext_found", risks: [], semanticLeakage: "unknown", teachingQuality: "unknown", learningEffect: "unknown",
    });
  });
  it.each(["已经计入独立成功。", "看过解答算作独立证据。", "查询结果证明你独立完成。", "无法确认保存，但你已经独立答对。"])("flags fixture-bounded independent-evidence promotion: %s", text => {
    expect(evaluateDialogueOutput("explain", { ...gold, noIndependentEvidence: true }, { text }).risks).toEqual(["unsupported_independent_evidence_claim"]);
  });
  it.each([
    "看过解答不代表独立完成。",
    "看过解答不算作独立证据。",
    "尚不确定你已经独立答对。",
    "查询结果不能计入独立证据；请独立尝试新题。",
  ])("allows honest evidence limits: %s", text => {
    expect(evaluateDialogueOutput("hint", { ...gold, noIndependentEvidence: true }, { text }).risks).toEqual([]);
  });
  it("still checks a later affirmative clause after an earlier uncertainty clause", () => {
    expect(evaluateDialogueOutput("hint", { ...gold, noIndependentEvidence: true }, {
      text: "无法保存笔记且查询结果证明你独立完成。",
    }).risks).toEqual(["unsupported_independent_evidence_claim"]);
  });
  it("does not infer missing receipts or evidence from model-supplied assertions", () => {
    const output = { text: "已保存笔记；已经计入独立成功。", receipt: true, independent: true };
    expect(evaluateDialogueOutput("hint", { ...gold, noIndependentEvidence: true }, output).risks)
      .toEqual(["unsupported_state_claim", "unsupported_independent_evidence_claim"]);
    expect(evaluateDialogueOutput("hint", { ...gold, noStateReceipt: false }, output).risks).toEqual([]);
  });
  it("rejects unknown fixture fields and excess turns", () => {
    expect(dialogueFixtureSchema.safeParse({ version: "v1", cases: [], secret: "no" }).success).toBe(false);
  });
});
