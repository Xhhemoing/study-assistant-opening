import { describe, expect, it } from "vitest";
import { hasRecordReadDemand, previousRecordQuestion, recordTopics } from "./system-record-demand";

describe("record demand and follow-up boundaries", () => {
  it.each(["这道练习怎么做", "帮我删除所有任务", "我今天练习积分"])("does not reuse a non-query as a record referent: %s", text => {
    const history = [{ role: "user", text: "高数进度怎么样" }, { role: "user", text }];
    expect(previousRecordQuestion(history)).toBeUndefined();
    expect(hasRecordReadDemand("刷新", history)).toBe(false);
  });
  it("preserves turn boundaries and punctuation inside each user question", () => {
    expect(previousRecordQuestion([
      { role: "user", text: "高数进度怎么样；当前任务有哪些" },
      { role: "assistant", text: "旧回答不是当前证据" },
      { role: "user", text: "那明天呢" },
    ])).toEqual(["高数进度怎么样；当前任务有哪些", "那明天呢"]);
  });
  it("can refresh a self-contained record question even when it starts like a continuation", () => {
    const history = [{ role: "user", text: "这道练习怎么做" }, { role: "user", text: "那我的笔记有哪些" }];
    expect(previousRecordQuestion(history)).toEqual(["那我的笔记有哪些"]);
    expect(hasRecordReadDemand("刷新", history)).toBe(true);
  });
  it("retains the original course when a self-contained continuation follows a record root", () => {
    expect(previousRecordQuestion([{ role: "user", text: "高数进度怎么样" }, { role: "user", text: "那练习情况呢" }]))
      .toEqual(["高数进度怎么样", "那练习情况呢"]);
  });
  it("does not truncate an oversized referent into a different query", () => {
    expect(previousRecordQuestion([{ role: "user", text: `高数进度怎么样${" ".repeat(2000)}；改查大学物理` }])).toBeUndefined();
  });
  it.each(["What is a planet?", "Why is this noteworthy?", "What is a postcard?"])("does not match English record topics inside another word: %s", text => {
    expect(recordTopics(text)).toEqual([]);
    expect(hasRecordReadDemand(text)).toBe(false);
  });
  it.each(["What is a plan?", "What is progress?", "Explain a quiz", "如何安排复习计划？"])("keeps general concepts out of personal record queries: %s", text => {
    expect(hasRecordReadDemand(text)).toBe(false);
  });
  it.each(["Show my saved notes", "What is my progress?", "What are my current plans?", "我的笔记呢", "我的卡片有哪些"])("recognizes a personal record lookup: %s", text => {
    expect(hasRecordReadDemand(text)).toBe(true);
  });
});
