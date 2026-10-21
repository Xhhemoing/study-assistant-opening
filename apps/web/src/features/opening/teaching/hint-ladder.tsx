import { Lightbulb } from "lucide-react";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";

/** Render only content actually delivered by the server. Missing levels stay absent. */
export function HintLadder({ delivered, next }: { delivered: Array<{ id: string; label: string; text: string }>; next?: { label: string; pending: boolean; disabled?: boolean; blockedReason?: string; request: () => void } }) {
  if (!delivered.length && !next) return null;
  return <section className="space-y-2 rounded-card border border-line bg-surface-2 p-4" aria-label="已收到的提示">
    <h4 className="flex items-center gap-2 text-sm font-medium text-text"><Lightbulb size={16} aria-hidden="true" />{delivered.length ? "已收到的提示" : "需要一点帮助？"}</h4>
    {delivered.length ? <ol className="space-y-3">{delivered.map(hint => <li key={hint.id}><p className="mb-1 text-xs font-medium text-text-2">{hint.label}</p><LearningProse text={hint.text} /></li>)}</ol> : null}
    {next ? <div className="space-y-2"><button className={ui.secondary} type="button" disabled={next.pending || next.disabled} onClick={next.request}>{next.pending ? "正在读取提示…" : `查看${next.label}`}</button>{next.blockedReason ? <p className="text-xs leading-5 text-text-2">{next.blockedReason}</p> : null}</div> : null}
    <p className="text-xs leading-5 text-text-2">每次只展开一级。实际收到的提示会计入本题帮助；完整示范须先封存首答。</p>
  </section>;
}
