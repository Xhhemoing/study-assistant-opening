import { Lightbulb } from "lucide-react";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";

/**
 * 「卡住了」提示阶梯：只渲染服务端实际发放的提示，缺失的级别不出现。
 * 每次只展开一级；已用级数以小圆点显示，让学生对「用了多少帮助」有感知。
 */
export function HintLadder({ delivered, next }: { delivered: Array<{ id: string; label: string; text: string }>; next?: { label: string; pending: boolean; disabled?: boolean; blockedReason?: string; request: () => void } }) {
  if (!delivered.length && !next) return null;
  return <section className="space-y-3 rounded-tile border border-line bg-surface-2 p-4" aria-label="已收到的提示" data-hint-ladder="true">
    <div className="flex items-center justify-between gap-3">
      <h4 className="flex items-center gap-2 text-ui-lg font-medium text-text"><Lightbulb size={16} aria-hidden="true" className="text-ai-2" />{delivered.length ? "已收到的提示" : "卡住了？"}</h4>
      {delivered.length ? <span className="flex items-center gap-1" aria-label={`已用 ${delivered.length} 级提示`} role="img">
        {delivered.map(hint => <span key={hint.id} aria-hidden="true" className="size-1.5 rounded-pill bg-ai-2" />)}
        {next ? <span aria-hidden="true" className="size-1.5 rounded-pill bg-line-strong" /> : null}
      </span> : null}
    </div>
    {delivered.length ? <ol className="space-y-3">{delivered.map(hint => <li key={hint.id} className="motion-safe:animate-enter"><p className="mb-1 text-meta font-medium text-text-2">{hint.label}</p><LearningProse text={hint.text} /></li>)}</ol> : null}
    {next ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button className={ui.secondary} type="button" disabled={next.pending || next.disabled} onClick={next.request}>{next.pending ? "正在读取提示…" : `查看${next.label}`}</button>
      <span className="text-meta text-text-3">提示会记入本题帮助</span>
      {next.blockedReason ? <p className="w-full text-xs leading-5 text-text-2">{next.blockedReason}</p> : null}
    </div> : null}
  </section>;
}
