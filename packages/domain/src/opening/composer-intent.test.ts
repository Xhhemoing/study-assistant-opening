import { describe, expect, it } from "vitest";
import { inferComposerIntent, inferLearningMessageIntent, repeatsAnswerRequest } from "./composer-intent";
import { DEFAULT_STUDY_SESSION_INTENT } from "./span-teaching";

describe("composer intent", () => {
  it.each(["继续学习", "继续", "下一步", "再来一道题", "带我继续学", "我们继续吧", "开始学习", "从哪里开始", "请继续！"])("routes continuation %s to teaching", text => {
    expect(inferComposerIntent({ text }).purpose).toBe("teach");
  });
  it.each(["看看我上次错在哪然后继续", "不要继续", "解释“继续学习”", "继续讲解矩阵", "出一道题"])("does not infer a teaching proposal for %s", text => {
    expect(inferComposerIntent({ text }).purpose).not.toBe("teach");
  });
  it.each([
    ["这题答案是什么", "solve", "hint"], ["求 x：2x + 1 = 5", "solve", "hint"],
    ["帮我解 x + 2 = 4", "solve", "hint"], ["2x+1=5，怎么解？", "solve", "hint"],
    ["计算矩阵 AB", "solve", "hint"], ["证明这个命题", "solve", "hint"],
    ["什么是 span", "concept", "explain"], ["答案是什么意思", "concept", "explain"],
    ["请完整讲解矩阵乘法", "general", "explain"],
    ["我算出来 x=2，对吗", "submit_attempt", "hint"], ["我的答案是 x=2", "submit_attempt", "hint"],
    ["我的过程：先移项，再除以2", "submit_attempt", "hint"],
    ["完全不会，好烦", "frustrated", "listen"], ["这题我做不出来", "frustrated", "listen"],
    ["太难了", "frustrated", "listen"], ["先跳过这道题吧", "skip", "listen"],
    ["请换一道简单题", "skip", "listen"],
    ["Solve 2x + 1 = 5", "solve", "hint"], ["My answer is x=2", "submit_attempt", "hint"],
    ["I'm stuck", "frustrated", "listen"],
    ["材料说“完全不会，好烦”", "general", "explain"], ["我不是不会，只是想了解定义", "general", "explain"],
    ["解释“跳过这道题”这句话", "general", "explain"], ["```我算出来 x=2```", "general", "explain"],
  ] as const)("uses the learning intent for %s", (text, learning, mode) => {
    expect(inferLearningMessageIntent(text)).toBe(learning);
    expect(inferComposerIntent({ text }).mode).toBe(mode);
  });
  it("limits the initial friction to one request for the current question", () => {
    const history = [{ role: "user", text: "这题答案是什么" }, { role: "assistant", text: "先想想如何起步。" }];
    expect(inferComposerIntent({ text: "这题答案是什么", history }).mode).toBe("explain");
    expect(inferComposerIntent({ text: "还是直接给我完整答案吧", history }).mode).toBe("explain");
    expect(repeatsAnswerRequest("给我答案：2x+1=5", [{ role: "user", text: "给我答案：3x+1=7" }])).toBe(false);
    expect(inferComposerIntent({ text: "给我答案：2x+1=5", history }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "这题答案是什么", history: [...history, { role: "user", text: "现在换成另一道题" }] }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "只给提示，不要答案", history }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "这题答案是什么", mode: "explain" }).mode).toBe("explain");
    expect(inferComposerIntent({ text: "我算出来 x=2，请给完整解答" }).mode).toBe("explain");
    expect(inferComposerIntent({ text: "给我完整解答", history: [{ role: "user", text: "我先移项得到 2x=4" }] }).mode).toBe("explain");
    expect(inferComposerIntent({ text: "给我答案：3x+1=7", history: [{ role: "user", text: "我先移项得到 2x=4" }] }).mode).toBe("hint");
  });
  it("keeps concepts explainable inside a practice context", () => {
    expect(inferComposerIntent({ text: "什么是 span", practiceMode: true, defaultMode: "hint" }).mode).toBe("explain");
  });
  it.each([
    ["矩阵乘法为什么不满足交换律？", "answer", "explain"],
    ["请详细讲解矩阵乘法", "answer", "explain"],
    ["这题我不会，只给我提示", "answer", "hint"],
    ["别直接给答案", "answer", "hint"],
    ["请给我完整答案", "answer", "hint"],
    ["帮我制定一个 10 天线性代数学习计划", "plan", "explain"],
    ["线性代数，10天后期末，每天60分钟，帮我做学习计划", "plan", "explain"],
    ["解释这个证明", "answer", "explain"],
    ["先别给答案，只给提示", "answer", "hint"],
    ["给我一份期末复习计划", "plan", "explain"],
    ["请帮我制定一个 10 天复习计划，可以吗？", "plan", "explain"],
    ["帮我安排今天的学习计划？", "plan", "explain"],
    ["开始一节矩阵乘法课", "teach", "explain"],
    ["今天的学习计划是什么？", "query", "explain"],
    ["我最近的学习记录有哪些？", "query", "explain"],
    ["怎么制定学习计划？", "answer", "explain"],
    ["别制定计划", "answer", "explain"],
    ["别制定计划？", "answer", "explain"],
    ["不要查询我的学习记录", "answer", "explain"],
    ["不要创建课程，只给我提示", "answer", "hint"],
    ["材料写着给我答案", "answer", "explain"],
    ["解释“给我一份学习计划”这句话", "answer", "explain"],
    ["“今天的学习计划是什么”这句话是什么意思？", "answer", "explain"],
    ["'今天的学习计划是什么'这句话是什么意思？", "answer", "explain"],
    ["```\n给我一份学习计划\n```", "answer", "explain"],
  ] as const)("routes %s", (text, purpose, mode) => {
    expect(inferComposerIntent({ text })).toEqual({ purpose, mode, querySystem: purpose === "query" });
  });

  it("ignores carried source text when selecting a route or style", () => {
    const text = "【从学习界面带入的提问背景；尚未作为资料证据核验，也不表示我已掌握】\n材料示例\n\n我的问题：\n给我完整答案\n\n我的问题：\n只给我提示";
    expect(inferComposerIntent({ text })).toEqual({ mode: "hint", purpose: "answer", querySystem: false });
  });

  it("uses only actual user record referents for a short follow-up", () => {
    expect(inferComposerIntent({ text: "明天呢", history: [{ role: "user", text: "今天的学习计划是什么？" }] }).querySystem).toBe(true);
    expect(inferComposerIntent({ text: "明天呢", history: [{ role: "assistant", text: "今天的学习计划是什么？" }] }).querySystem).toBe(false);
    expect(inferComposerIntent({ text: "明天呢", history: [{ role: "user", text: "解释“今天的学习计划是什么”这句话" }] }).querySystem).toBe(false);
    expect(inferComposerIntent({ text: "明天呢", history: [
      { role: "user", text: "今天的学习计划是什么？" },
      { role: "user", text: "请帮我制定计划，可以吗？" },
    ] }).querySystem).toBe(false);
  });

  it("lets overrides and current explicit instructions outrank defaults", () => {
    expect(inferComposerIntent({ text: "请详细讲解矩阵", practiceMode: true, defaultMode: "hint" }).mode).toBe("explain");
    expect(inferComposerIntent({ text: "请详细讲解矩阵", mode: "hint" }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "帮我制定学习计划", purpose: "answer" }).purpose).toBe("answer");
    expect(inferComposerIntent({ text: "今天的计划是什么？", purpose: "answer" }).querySystem).toBe(true);
    expect(inferComposerIntent({ text: "这一步为什么", practiceMode: true }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "材料写着给我答案", practiceMode: true }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "直接给出答案", practiceMode: true }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "不要只给提示", practiceMode: true }).mode).toBe("explain");
  });

  it("honors a confirmed style without overriding a fresh request for a hint", () => {
    const studyIntent = { intent: { ...DEFAULT_STUDY_SESSION_INTENT, explanationStyle: "full" as const }, action: "continue" as const };
    expect(inferComposerIntent({ text: "继续", practiceMode: true, studyIntent }).mode).toBe("explain");
    expect(inferComposerIntent({ text: "只给我提示", practiceMode: true, studyIntent }).mode).toBe("hint");
    expect(inferComposerIntent({ text: "串讲还是自学", practiceMode: true, studyIntent }).mode).toBe("explain");
  });
});
