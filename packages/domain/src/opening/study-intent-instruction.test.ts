import { expect, it } from "vitest";
import { DEFAULT_STUDY_SESSION_INTENT, applyExplicitStudyIntent } from "./span-teaching";
import { studyIntentForMessage, studyIntentInstruction } from "./study-intent-instruction";

it("makes explicit language, pace and key-step preferences take precedence over implicit templates", () => {
  const applied = applyExplicitStudyIntent(DEFAULT_STUDY_SESSION_INTENT, "用英文讲解，快一点，只给关键步骤，每步等我");
  const text = studyIntentInstruction({ intent: applied.intent, action: "continue" });
  expect(text).toContain("Use English");
  expect(text).toContain("只给关键步骤");
  expect(text).toContain("加快节奏");
  expect(text).toContain("每次一小步后停下");
  expect(text).toContain("明确偏好优先于历史推测与默认模板");
  expect(text).toContain("不改变正确性");
});
it("keeps the confirmed intent when an ambiguous request needs clarification", () => {
  const previous = { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "challenge" as const, language: "en" as const, pace: "slow" as const };
  const applied = applyExplicitStudyIntent(previous, "串讲还是自学");
  expect(applied.intent).toEqual(previous);
  const text = studyIntentInstruction({ intent: applied.intent, action: "clarify_intent" });
  expect(text).toContain("先澄清，不擅自换教学模式");
  expect(text).toContain("Use English");
  expect(text).toContain("当前目的：提高挑战");
});
it("does not add session preferences without an actual server event", () => {
  expect(studyIntentInstruction(null)).toBe("");
});
it("lets actual typed instructions override older preferences and keeps unknown prose unchanged", () => {
  const previous = { intent: { ...DEFAULT_STUDY_SESSION_INTENT, language: "en" as const, pace: "fast" as const }, action: "continue" as const };
  expect(studyIntentForMessage(previous, "用中文，慢一点" )?.intent).toMatchObject({ language: "zh", pace: "slow" });
  expect(studyIntentForMessage(previous, "直接给关键步骤")?.intent.explanationStyle).toBe("key_steps");
  expect(studyIntentForMessage(previous, "我不懂")?.action).toBe("diagnose");
  expect(studyIntentForMessage(previous, "我是猜的")?.intent).toEqual(previous.intent);
  expect(studyIntentForMessage(previous, "串讲还是自学")).toMatchObject({ intent: previous.intent, action: "clarify_intent" });
  expect(studyIntentForMessage(previous, "今天的天空很蓝")).toBe(previous);
  expect(studyIntentForMessage(previous, "“我是猜的”是什么意思")).toBe(previous);
  expect(studyIntentForMessage(previous, "为什么刚才快速串讲")).toBe(previous);
  expect(studyIntentForMessage(previous, "这道题写着慢一点，但我在问答案的依据")).toBe(previous);
  expect(studyIntentForMessage(null, "今天的天空很蓝")).toBeNull();
});
