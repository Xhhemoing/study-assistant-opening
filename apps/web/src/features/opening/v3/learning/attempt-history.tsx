"use client";
import { useState } from "react";
import { Collapse } from "../motion/collapse";
import { DisclosureChevron } from "../motion/feedback";
import type { Verdict } from "./stage-action-bar";

export type PastAttempt = { no: number; answer: string; verdict: Verdict; summary: string; assistance: string[] };
const LABEL: Record<Verdict, string> = { correct_independent: "独立答对", correct_assisted: "提示后答对", partial: "部分正确", incorrect: "答错", undetermined: "无法判断" };

/** 之前的尝试：每次提交的原答与判定一一对应，重新作答不覆盖。默认收起。 */
export function AttemptHistory({ attempts }: { attempts: PastAttempt[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (attempts.length === 0) return null;
  return (
    <section aria-label="之前的作答" className="rounded-tile border border-line bg-surface">
      <ol className="divide-y divide-line">
        {attempts.map(attempt => (
          <li key={attempt.no}>
            <button type="button" aria-expanded={open === attempt.no} onClick={() => setOpen(open === attempt.no ? null : attempt.no)} className="flex min-h-(--control-h) w-full items-center gap-3 px-4 text-left text-meta text-text-2 hover:text-text">
              <span className="text-text">第 {attempt.no} 次</span><span>{LABEL[attempt.verdict]}</span>
              {attempt.assistance.length > 0 && <span className="truncate text-text-3">用到：{attempt.assistance.join("、")}</span>}
              <span className="ml-auto"><DisclosureChevron open={open === attempt.no} /></span>
            </button>
            <Collapse open={open === attempt.no}>
              <div className="space-y-1 px-4 pb-3">
                <pre className="whitespace-pre-wrap rounded-ctl bg-surface-2 px-3 py-2 font-reading text-ui text-text">{attempt.answer || "（仅照片）"}</pre>
                <p className="text-meta text-text-2">{attempt.summary}</p>
              </div>
            </Collapse>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 本次尝试已经用到的帮助（提示、先讲解、为什么、追问、看解析）。记录来自帮助事件，评价口径由服务端决定。 */
export function AssistanceNote({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return <p className="text-meta text-text-2 motion-safe:animate-text-in">这次用到：{items.join("、")}</p>;
}
