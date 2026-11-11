"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LearningAdviceRequestModel, learningAdviceContextKey,
  type LearningAdviceContext, type LearningAdviceTransport } from "./learning-advice-request-model";

type Props = { context: LearningAdviceContext | null; transport: LearningAdviceTransport };
const ruleLabels = {
  diagnose: "先做一次独立检查。",
  targeted_explain: "先复习出错的步骤。",
  reduced_help_practice: "练习时逐步减少提示。",
  transfer_check: "试试不同情境的练习。",
  full_explain: "先学习完整讲解。",
};
const fallbackLabels = {
  disabled: "实验尚未开放，仍使用规则建议。",
  incomplete_target: "当前练习信息不完整，仍使用规则建议。",
  invalid_cutoff: "暂时无法读取实验记录，仍使用规则建议。",
  priority_rule: "复测、明确学习请求或纠错等规则优先，仍使用规则建议。",
  no_qualified_samples: "无足够独立记录，仍用规则建议。",
  insufficient_samples: "无足够独立记录，仍用规则建议。",
  additional_support: "实验结果不可用于比较，仍使用规则建议。",
  retain_rule: "实验结果不可用于比较，仍使用规则建议。",
};

/** Injected request UI only: no page mount, endpoint, authentication or grant provider. */
export function LearningAdviceRequest(props: Props) {
  // Remount before rendering a different identity: no old result paints while effects catch up.
  return <RequestSession key={learningAdviceContextKey(props.context)} {...props} />;
}
function RequestSession({ context, transport }: Props) {
  const [initialContext] = useState(context);
  const model = useMemo(() => new LearningAdviceRequestModel(transport), [transport]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    model.setContext(initialContext);
    let inactive = document.visibilityState === "hidden";
    if (inactive) model.suspend();
    const suspend = () => { inactive = true; model.suspend(); };
    const resume = () => {
      if (inactive && document.visibilityState !== "hidden") { inactive = false; model.refresh(); }
    };
    const visibility = () => { if (document.visibilityState === "hidden") suspend(); else resume(); };
    window.addEventListener("blur", suspend);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("blur", suspend);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
      model.clear();
    };
  }, [initialContext, model]);
  const advice = state.advice;
  const message = state.status === "loading" ? "正在读取实验建议，当前仍以规则建议为准。"
    : state.status === "off" ? "实验尚未开放，仍使用规则建议。"
      : state.status !== "ready" || !advice ? "实验暂时不可用，原学习记录和步骤保留。"
        : advice.status === "fallback" ? fallbackLabels[advice.reason]
          : advice.status === "compared" ? advice.experimentalAdvice.kind === "supported_practice"
            ? "实验提示：可考虑增加有支持的练习；当前行动仍以规则建议为准。"
            : "实验提示：保留当前规则建议。"
            : "实验暂时不可用，原学习记录和步骤保留。";
  return <section aria-label="学习建议请求" className="space-y-3 rounded-xl border border-line bg-surface p-4">
    <div aria-label="当前规则建议" className="space-y-1">
      <h3 className="text-sm font-semibold">规则建议 · 当前使用</h3>
      <p className="text-sm leading-7">{state.rule ? ruleLabels[state.rule.activityKind]
        : state.status === "loading" ? "正在读取规则建议，原学习步骤保留。"
          : "暂时无法读取建议，原学习记录和步骤保留。"}</p>
    </div>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={state.optedIn} disabled={context === null}
        onChange={event => model.setOptIn(event.target.checked)}
        className="h-4 w-4 rounded border-line focus-visible:ring-2 focus-visible:ring-focus-ring" />
      查看未校准实验建议（仅本次）
    </label>
    {state.optedIn ? <div role="status" aria-label="未校准实验建议" className="space-y-1 border-t border-line pt-3">
      <h3 className="text-sm font-semibold">未校准实验建议 · 只读对照</h3>
      <p className="text-sm leading-7">{message}</p>
    </div> : <p role="status" className="text-xs leading-6 text-text-2">实验默认关闭；开启意愿不代表实验已获准。</p>}
    {state.error !== null ? <p role="alert" className="text-sm leading-7">建议读取失败，原学习记录和步骤保留。可手动重试。</p> : null}
    {state.status === "unavailable" && context !== null ? <button type="button" onClick={() => model.retry()}
      className="rounded-md border border-line px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-focus-ring">重新读取建议</button> : null}
    <p className="text-xs leading-6 text-text-2">尚未校准，不代表掌握程度，不改变晋级或考试安排，不自动选题。样本门槛是实验约定，不是充分学习证据。</p>
    <p className="text-xs leading-6 text-text-2">仅用于本次请求和只读对照，不保存为用户设置。</p>
  </section>;
}
