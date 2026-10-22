"use client";
import { useState, type ReactNode } from "react";
import { ui } from "../ui/controls";
import { Collapse } from "../motion/collapse";
import { TransitionLink } from "../motion/view-transition";
import { ListRow, ListSection } from "../ui/list";
import { PageHeader } from "../shell/page-header";

export type SprintTask = { id: string; title: string; reason: string; minutes?: number; href: string };
export type PlanChange = { kind: "add" | "remove" | "postpone"; title: string };
export type PlanOption = { id: string; summary: string; changes: PlanChange[]; minutesNote?: string };
export type ApplyState = "idle" | "applying" | "failed";

type SprintBoardProps = {
  courseTitle: string;
  examDateLabel: string;
  todayBudgetLabel?: string;
  current: { tasks: SprintTask[] } | null;
  planStatus: "ready" | "generating" | "unavailable";
  options: PlanOption[];
  applyState: ApplyState;
  onApply: (optionId: string) => void;
  /** 服务端确认应用后新出现的任务 id：短暂高亮一次 */
  freshTaskIds?: string[];
  tools?: ReactNode;
};

const CHANGE_LABEL: Record<PlanChange["kind"], string> = { add: "新增", remove: "减少", postpone: "后移" };

/**
 * T7 冲刺页：默认执行当前计划；调整是次要入口；预览不等于已应用。
 * 动效：调整区高度展开；预览块淡入；应用成功由调用方用 runViewTransition 包住数据替换，新任务高亮一次。
 */
export function SprintBoard({ courseTitle, examDateLabel, todayBudgetLabel, current, planStatus, options, applyState, onApply, freshTaskIds = [], tools }: SprintBoardProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const next = current?.tasks[0];
  const preview = options.find(option => option.id === previewId) ?? null;

  return (
    <div data-scroll-root className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <PageHeader title="考前冲刺" tools={tools} fact={[courseTitle, `${examDateLabel}考试`, todayBudgetLabel].filter(Boolean).join(" · ")}
        action={next ? <TransitionLink href={next.href} direction="forward" className={ui.primary}>开始：{next.title}</TransitionLink> : null} />
      <div className="pb-10 pt-4">
        <div className="content-grid">
          {planStatus !== "ready" || !current ? (
            <p className="text-ui text-text-2">{planStatus === "generating" ? "正在生成计划。课程里的学习和复习照常可用。" : "暂时无法读取计划。可以先从课程继续学习。"}</p>
          ) : (
            <ListSection title="今天" framed ordered>
              {current.tasks.map(task => <ListRow key={task.id} framed href={task.href} title={task.title} meta={task.reason} trailing={task.minutes ? `约 ${task.minutes} 分钟` : undefined} highlight={freshTaskIds.includes(task.id)} />)}
            </ListSection>
          )}

          {options.length > 0 && current && (
            <section aria-label="调整安排">
              <button type="button" aria-expanded={adjusting} onClick={() => setAdjusting(value => !value)} className={`${ui.quiet} -ml-3`}>
                {adjusting ? "收起调整" : "调整安排"}
              </button>
              <Collapse open={adjusting}>
                <div className="space-y-2 pt-2">
                  <div role="radiogroup" aria-label="候选安排" className="space-y-2">
                    {options.map(option => (
                      <label key={option.id} className="flex cursor-pointer items-start gap-3 rounded-ctl border border-line bg-surface p-3 transition-colors duration-(--duration-micro) hover:border-line-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
                        <input type="radio" name="sprint-option" value={option.id} checked={previewId === option.id} onChange={() => setPreviewId(option.id)} className="mt-1 accent-accent" />
                        <span className="text-ui text-text">{option.summary}{option.minutesNote ? <span className="block text-meta text-text-2">{option.minutesNote}（估计）</span> : null}</span>
                      </label>
                    ))}
                  </div>
                  {preview && (
                    <div key={preview.id} className="rounded-ctl bg-surface-2 p-3 motion-safe:animate-enter">
                      <p className="text-meta text-text-2">预览，尚未生效</p>
                      <ul className="mt-1 text-ui text-text">{preview.changes.map((change, index) => <li key={index}>{CHANGE_LABEL[change.kind]}：{change.title}</li>)}</ul>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => onApply(preview.id)} disabled={applyState === "applying"} className={ui.primary}>{applyState === "applying" ? "正在应用…" : "应用这个安排"}</button>
                        <button type="button" onClick={() => setPreviewId(null)} className={ui.quiet}>取消</button>
                        {applyState === "failed" && <p role="alert" className="text-meta text-danger motion-safe:animate-enter">没有生效，当前计划不变</p>}
                      </div>
                    </div>
                  )}
                </div>
              </Collapse>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
