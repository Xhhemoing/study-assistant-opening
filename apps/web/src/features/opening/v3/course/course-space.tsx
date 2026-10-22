import type { ReactNode } from "react";
import { ui } from "../ui/controls";
import { TransitionLink } from "../motion/view-transition";
import { PageHeader } from "../shell/page-header";
import { featureHref } from "../shell/features";

export type CourseSection = "study" | "practice" | "review" | "library" | "notes" | "progress";
const SECTIONS: { key: CourseSection; label: string }[] = [
  { key: "study", label: "学习" }, { key: "practice", label: "练习" }, { key: "review", label: "复习" },
  { key: "library", label: "资料" }, { key: "notes", label: "笔记" }, { key: "progress", label: "进展" },
];

type CourseSpaceProps = {
  courseId: string;
  title: string;
  fact?: string;
  section: CourseSection;
  counts?: Partial<Record<CourseSection, number>>;
  resume?: { label: string; href: string };
  tools?: ReactNode;
  /** 课程级次要入口（考试设置等），放在分区行右侧 */
  extra?: ReactNode;
  children: ReactNode;
};

/**
 * T5 课程空间。分区用链接（每个分区一个 URL，history 正确）。
 * 动效：分区切换走同级过渡；分区为胶囊分段，当前底块带 view-transition-name，在分区间滑动；标题承接来源行。
 * 分区链接用 ?section=，迁移时按现有课程路由调整（见 MIGRATION.md）。
 */
export function CourseSpace({ courseId, title, fact, section, counts = {}, resume, tools, extra, children }: CourseSpaceProps) {
  const base = featureHref("course", { id: courseId });
  return (
    <div data-scroll-root className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <PageHeader title={title} fact={fact} tools={tools} sharedTitle
        action={resume ? <TransitionLink href={resume.href} direction="forward" className={ui.primary}>继续：{resume.label}</TransitionLink> : null} />
      <nav aria-label="课程分区" className="content-grid pt-2">
        <div className="col-wide flex items-center gap-2">
        <ul className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-pill bg-text/5 p-0.5 sm:flex-none">
          {SECTIONS.map(item => (
            <li key={item.key}>
              <TransitionLink href={item.key === "study" ? base : `${base}?section=${item.key}`} replace direction="swap" aria-current={section === item.key ? "page" : undefined}
                className="relative flex h-(--control-h-sm) items-center gap-1 whitespace-nowrap rounded-pill px-3.5 text-meta text-text-2 transition-colors duration-(--duration-micro) hover:text-text aria-[current=page]:font-medium aria-[current=page]:text-text">
                {section === item.key && <span aria-hidden="true" className="absolute inset-0 rounded-pill bg-surface shadow-card [view-transition-name:section-active]" />}
                <span className="relative">{item.label}</span>{counts[item.key] ? <span className="relative text-cap tabular-nums text-accent">{counts[item.key]}</span> : null}
              </TransitionLink>
            </li>
          ))}
        </ul>
        <span className="flex-1" />{extra}
        </div>
      </nav>
      <div key={section} className="content-grid pb-10 pt-5 motion-safe:animate-fade-in">{children}</div>
    </div>
  );
}
