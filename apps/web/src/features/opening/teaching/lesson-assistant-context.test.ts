import { expect, it } from "vitest";
import type { TeachingToolsContext } from "./teaching-workspace";
import { spanAssistantContext, spanPracticeEntryKey, teachingAssistantContext } from "./lesson-assistant-context";
const id = "11111111-1111-4111-8111-111111111111";
function context(): TeachingToolsContext {
  return { activity: { id, courseId: id, sourceIds: [id] } as TeachingToolsContext["activity"], blockId: id, contentVersion: 3, unitTitle: "当前单元", unitText: "当前文字", sourceRefs: [{ sourceId: id, version: 2 }], isQuestion: false, learningAttempt: null };
}
it("keeps a unique pinned source and current activity identity on explanation selections", () => {
  expect(teachingAssistantContext(context())).toMatchObject({ blockedReason: undefined, context: { courseId: id, activityId: id, blockId: id, contentVersion: 3, sourceId: id, sourceVersion: 2 } });
});
it("does not bypass source choice or missing source-version guards", () => {
  const value = context(); value.sourceRefs.push({ sourceId: id, version: 3 });
  expect(teachingAssistantContext(value).blockedReason).toContain("选定");
  value.sourceRefs = [{ sourceId: id }]; expect(teachingAssistantContext(value).blockedReason).toContain("版本暂不可核实");
  value.sourceRefs = []; expect(teachingAssistantContext(value).blockedReason).toContain("没有可锁定");
});
it("blocks generic question help until the real attempt is available", () => {
  const value = { ...context(), isQuestion: true };
  expect(teachingAssistantContext(value).blockedReason).toContain("先保存");
  value.learningAttempt = { id, itemVersionId: id } as NonNullable<TeachingToolsContext["learningAttempt"]>;
  expect(teachingAssistantContext(value)).toMatchObject({ blockedReason: undefined, learningAttempt: value.learningAttempt, context: { attemptId: id, itemVersionId: id } });
  expect(teachingAssistantContext(value).context.sourceId).toBeUndefined();
});
it("separates span retest and new-evidence entries, and blocks unavailable demonstrations", () => {
  expect(spanPracticeEntryKey(id, "self_study", "reserved:auto", id)).not.toBe(spanPracticeEntryKey(id, "self_study", "reserved:auto", undefined, id));
  expect(spanAssistantContext(id, true, null, false)).toMatchObject({ learningAttempt: null, blockedReason: expect.any(String) });
  expect(spanAssistantContext(id, false, null, false)).toMatchObject({ learningAttempt: null, blockedReason: expect.any(String) });
});
