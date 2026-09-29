import type { ReviewDraft, ReviewItem } from "./review-types";
import { inputClass as sharedInputClass } from "../design/ui";
const inputClass = `${sharedInputClass} mt-1`;
export function ReviewFields({ item, draft, disabled, onChange }: { item: ReviewItem; draft: ReviewDraft; disabled: boolean; onChange: (draft: ReviewDraft) => void }) {
  const change = (key: keyof ReviewDraft, value: string) => onChange({ ...draft, [key]: value });
  if (item.proposal.kind === "memory") return <div className="space-y-3">
    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-800">{item.proposal.text}</p>
    <p className="text-xs leading-5 text-zinc-500">确认后才进入后续上下文。当前支持确认或不记住，不能在此修改记忆文字。</p>
    {item.proposal.temporary ? <label className="block text-xs text-zinc-600">临时记忆保留至<input type="datetime-local" value={draft.expiresAt} onChange={(event) => change("expiresAt", event.target.value)} disabled={disabled} required className={inputClass} /></label> : <p className="text-sm text-zinc-600">长期记忆：确认后可在助理的记忆管理中删除。</p>}
  </div>;
  if (item.proposal.kind === "retest") return <div className="space-y-2">
    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-800">{item.proposal.prompt}</p>
    <p className="text-sm text-zinc-600">建议时间：{new Date(item.proposal.dueAt).toLocaleString("zh-CN")}</p>
    <p className="text-xs leading-5 text-zinc-500">接受后创建约 20 分钟的任务，不设硬截止或自动排入日历。当前补测接口不支持修改题目和建议时间。</p>
  </div>;
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className="block text-xs text-zinc-600 sm:col-span-2">任务名称<input value={draft.title} maxLength={240} required disabled={disabled} onChange={(event) => change("title", event.target.value)} className={inputClass} /></label>
    <label className="block text-xs text-zinc-600">预计分钟数<input type="number" min={1} max={1440} required disabled={disabled} value={draft.minutes} onChange={(event) => change("minutes", event.target.value)} className={inputClass} /></label>
    <label className="block text-xs text-zinc-600">优先级<select disabled={disabled} value={draft.priority} onChange={(event) => change("priority", event.target.value)} className={inputClass}><option value="1">普通</option><option value="2">较高</option><option value="0">较低</option></select></label>
    <label className="block text-xs text-zinc-600 sm:col-span-2">明确截止时间（可留空）<input type="datetime-local" disabled={disabled} value={draft.dueAt} onChange={(event) => change("dueAt", event.target.value)} className={inputClass} /></label>
    {!draft.dueAt ? <label className="block text-xs text-zinc-600 sm:col-span-2">时间备注（不会自动变成截止时间）<input disabled={disabled} value={draft.dueText} maxLength={200} onChange={(event) => change("dueText", event.target.value)} className={inputClass} /></label> : <p className="text-xs text-zinc-500 sm:col-span-2">仅使用你填写的明确截止时间。</p>}
  </div>;
}
