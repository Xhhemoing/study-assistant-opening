"use client";

import { useState } from "react";
import type { ExperimentalLearningAdvicePort } from "./experimental-learning-advice-port";

const ruleLabels = {
  diagnose: "先做一次独立检查。",
  targeted_explain: "先复习出错的步骤。",
  reduced_help_practice: "练习时逐步减少提示。",
  transfer_check: "试试不同情境的练习。",
  full_explain: "先学习完整讲解。",
};
const fallbackLabels = {
  disabled: "服务尚未开放实验展示，仍使用规则建议。",
  incomplete_target: "当前练习的身份或版本不完整，仍使用规则建议。",
  invalid_cutoff: "记录时间无法核实，仍使用规则建议。",
  priority_rule: "复测、明确学习请求或纠错等规则优先，仍使用规则建议。",
  no_qualified_samples: "无足够独立记录，仍用规则建议。",
  insufficient_samples: "无足够独立记录，仍用规则建议。",
  additional_support: "实验结果不可用于比较，仍使用规则建议。",
  retain_rule: "实验结果不可用于比较，仍使用规则建议。",
};

/** Mountable read-only caller. The host supplies the port; no fetch/settings writes. */
export function ExperimentalLearningAdvice({ advice }: { advice: ExperimentalLearningAdvicePort }) {
  const [optedIn, setOptedIn] = useState(false);
  const message = advice.status === "disabled" ? fallbackLabels.disabled
    : advice.status === "unavailable" ? "实验所需记录尚未接入，仍使用规则建议。"
      : advice.status === "fallback" ? fallbackLabels[advice.reason]
        : advice.experimentalAdvice.kind === "supported_practice" ? "实验提示：可考虑增加有支持的练习；当前行动仍以规则建议为准。"
          : "实验提示：保留当前规则建议。";
  return <section aria-label="学习建议对照" className="space-y-3 rounded-xl border border-line bg-surface p-4">
    <div className="space-y-1" aria-label="当前规则建议">
      <h3 className="text-sm font-semibold">规则建议 · 当前使用</h3>
      <p className="text-sm leading-7">{ruleLabels[advice.ruleDecision.activityKind]}</p>
    </div>
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={optedIn} onChange={event => setOptedIn(event.target.checked)} className="h-4 w-4 rounded border-line focus-visible:ring-2 focus-visible:ring-focus-ring" />
      查看未校准实验建议（仅本次展示）
    </label>
    {optedIn ? <div className="space-y-1 border-t border-line pt-3" role="status" aria-label="未校准实验建议">
      <h3 className="text-sm font-semibold">未校准实验建议 · 只读对照</h3>
      <p className="text-sm leading-7">{message}</p>
      <p className="text-xs leading-6 text-text-2">实验尚未校准，不代表掌握程度，不改变晋级或考试安排，不自动选题。样本门槛是实验约定，不是充分学习证据。</p>
    </div> : <p className="text-xs leading-6 text-text-2">实验展示默认关闭；当前只使用规则建议。</p>}
    <p className="text-xs leading-6 text-text-2">此开关只控制当前组件展示，不保存为用户设置。</p>
  </section>;
}
