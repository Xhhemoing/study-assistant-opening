"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { ui } from "../v3/ui/controls";
import { LEARNING_HOME_HREF } from "./destinations";

export type LearningSection = "today" | "courses" | "review";

const SECTIONS: { id: LearningSection; label: string; href: string }[] = [
  { id: "today", label: "今天", href: LEARNING_HOME_HREF },
  { id: "courses", label: "课程", href: `${LEARNING_HOME_HREF}?view=all` },
  { id: "review", label: "复习", href: "/opening/review" },
];

/**
 * 学习入口内的分段切换：今天（继续与进展）/ 课程 / 复习。放在页头工具位，
 * 复习与卡组归学习，不再占一级导航；冲刺、模考从课程进入。
 */
export function LearningSwitch({ current, dueCount }: { current: LearningSection; dueCount?: number | null }) {
  return <nav aria-label="学习分区" className={ui.segment}>
    {SECTIONS.map(section => <Link key={section.id} href={section.href} aria-current={current === section.id ? "page" : undefined}
      className={`${ui.segmentItem} inline-flex items-center gap-1 aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-text aria-[current=page]:shadow-card`}>
      {section.label}{section.id === "review" && dueCount ? <span className="tabular-nums text-accent">{dueCount}<span className="sr-only">项待复习</span></span> : null}
    </Link>)}
  </nav>;
}
