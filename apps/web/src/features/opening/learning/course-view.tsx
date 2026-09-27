"use client";

import { useEffect, useState } from "react";
import { createOpeningLearningClient } from "../client/learning-client";
import type { LearningSummary } from "@aistudy/contracts";

const STATUS_LABEL: Record<LearningSummary["status"], string> = {
  unobserved: "尚无观察",
  needs_check: "需要核验",
  observed_independent: "观察到独立完成",
  needs_review: "需要复习",
};
const SOURCE_LABEL: Record<string, string> = {
  self_report: "自报",
  reference_checked: "参考核验",
  model_suggestion: "模型建议",
  unknown: "未知",
};

export function CourseLearningView({ courseId }: { courseId: string }) {
  const [summary, setSummary] = useState<LearningSummary[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setState("loading");
    void createOpeningLearningClient().getSummary(courseId).then((next) => {
      if (!active) return;
      setSummary(next);
      setState("ready");
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "学习证据暂时无法读取");
      setState("error");
    });
    return () => { active = false; };
  }, [courseId]);

  return (
    <section className="space-y-3 border-t border-line pt-6" aria-labelledby="opening-learning-heading">
      <div>
        <h2 id="opening-learning-heading" className="text-base font-semibold text-text">学习证据</h2>
        <p className="mt-1 text-sm leading-6 text-text-dim">这里展示服务器记录的观察，不把一次回答当作掌握证明。</p>
      </div>
      {state === "loading" ? <p className="text-sm text-text-dim" role="status">正在读取学习证据…</p> : null}
      {state === "error" ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {state === "ready" && summary.length === 0 ? <p className="text-sm text-text-dim">还没有这门课程的学习观察。</p> : null}
      {state === "ready" && summary.length > 0 ? (
        <ul className="divide-y divide-line border-y border-line">
          {summary.map((item) => (
            <li key={item.skillLabel} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-3">
              <span className="min-w-0 text-sm font-medium text-text">{item.skillLabel}</span>
              <span className="text-xs text-text-dim">{STATUS_LABEL[item.status]} · {item.sampleCount} 条观察</span>
              <span className="w-full text-xs text-text-dim">证据来源：{item.evidenceSources?.map((source) => SOURCE_LABEL[source] ?? source).join("、") || "无"} · {item.evidenceIds.length ? `${item.evidenceIds.length} 条服务器记录` : "无"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
