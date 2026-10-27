"use client";

import { ArrowRight } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { StartSuggestion } from "./start-composer";

/**
 * 助理首页的一张下一步：只来自已保存记录（断点、到期复习、考试日期），不由模型生成。
 * 一个主动作，进入原规范页面；不在首页内嵌执行器。
 */
export function NextStepCard({ item, objectHref = href => href }: { item: StartSuggestion; objectHref?: (href: string) => string }) {
  const resume = item.id.startsWith("activity:") || item.id.startsWith("conversation:");
  const title = item.label.replace(/^继续：/, "");
  return <article aria-label="建议下一步" className="rounded-tile border border-line bg-surface p-4 shadow-card">
    <p className="text-cap text-text-3">{resume ? "接着上次" : "建议下一步"}{item.meta ? <span> · {item.meta}</span> : null}</p>
    <h2 className="mt-1 text-ui-lg font-semibold text-text">{title}</h2>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Link href={objectHref(item.href)} className="inline-flex h-(--control-h) items-center gap-1.5 rounded-pill bg-ink px-(--control-px) text-ui font-medium text-on-ink transition-colors hover:bg-ink/88 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        {resume ? "继续" : "开始"}<ArrowRight size={15} aria-hidden="true" />
      </Link>
    </div>
  </article>;
}
