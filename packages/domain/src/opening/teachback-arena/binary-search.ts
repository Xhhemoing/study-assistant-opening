import type { TeachbackArenaChallenge, TeachbackTarget } from "./index";

/** A hand-authored coaching example, independent of the reserved retest bank. */
export function binarySearchTeachback(target: TeachbackTarget): TeachbackArenaChallenge {
  return {
    challengeId: "closed-interval-binary-search-v1", target,
    prompt: "笨学弟想在有序数组 [2, 5] 里找 5。请指出推导第一次出错的步骤，选出修复方法，并说明理由。",
    steps: [
      { stepId: "bounds", text: "我用闭区间 [lo, hi] 表示候选范围，初始为 [0, 1]。" },
      { stepId: "compare", text: "中点向下取整得到 mid = 0。数组里的 2 小于目标 5。" },
      { stepId: "advance", text: "目标在右边，所以我令 lo = mid，继续搜索 [0, 1]。" },
      { stepId: "conclude", text: "又得到相同的中点。我认为这说明数组里没有 5。" },
    ],
    repairs: [
      { id: "limit", text: "给循环加上次数限制，到达上限就报告找不到。" },
      { id: "exclude-mid", text: "令 lo = mid + 1，接着检查区间 [1, 1]。" },
    ],
    invariantRules: [
      { id: "shrinking-candidates", text: "目标若存在，始终留在候选区间；每次未命中的比较都必须缩小区间。" },
      { id: "bounded-runtime", text: "只要循环能在有限步内停止，返回的答案就正确。" },
    ],
    rubric: { firstFlawedStepId: "advance", symptomStepIds: ["conclude"],
      validRebuttals: [{ selectedRepairId: "exclude-mid", invariantRuleId: "shrinking-candidates" }] },
  };
}
