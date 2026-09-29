import { describe, expect, it, vi } from "vitest";
import { replacePromptDraft, taskPrompt } from "./study-task";
const task = { id: "task-1", title: "理解动量守恒", minutes: 20, status: "pending" as const, dueAt: null, priority: 1 };
describe("explicit task prompt", () => {
  it("contains the selected task title and time without modifying it", () => {
    expect(taskPrompt(task)).toContain("理解动量守恒");
    expect(taskPrompt(task)).toContain("20 分钟");
    expect(task.status).toBe("pending");
  });
  it("fills an empty draft without confirmation", () => {
    const confirm = vi.fn(() => false);
    expect(replacePromptDraft("", taskPrompt(task), confirm)).toBe(taskPrompt(task));
    expect(confirm).not.toHaveBeenCalled();
  });
  it("preserves an unsent draft when replacement is declined", () => {
    const confirm = vi.fn(() => false);
    expect(replacePromptDraft("我的未发问题", taskPrompt(task), confirm)).toBe("我的未发问题");
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("replaces the unsent draft only after confirmation", () => {
    expect(replacePromptDraft("旧草稿", taskPrompt(task), () => true)).toBe(taskPrompt(task));
  });
  it("does not ask to replace an identical draft", () => {
    const confirm = vi.fn(() => false);
    expect(replacePromptDraft("已有草稿", "已有草稿", confirm)).toBe("已有草稿");
    expect(confirm).not.toHaveBeenCalled();
  });
});
