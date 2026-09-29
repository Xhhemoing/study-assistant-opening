"use client";
import Link from "next/link";
import { useState } from "react";
import { Check, ArrowRight } from "lucide-react";
import { ReviewFields } from "./review-fields";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { initialReviewDraft, type createReviewActions } from "./review-service";
import type { ReviewAction, ReviewItem, ReviewOutcome } from "./review-types";

export function ReviewCard({ item, actions }: { item: ReviewItem; actions: ReturnType<typeof createReviewActions> }) {
  const [draft, setDraft] = useState(() => initialReviewDraft(item));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const pending = actions.pending(item);
  const category = item.proposal.kind === "task" ? "助理任务" : item.proposal.kind === "memory" ? "助理记忆" : "补测建议";
  async function decide(action: ReviewAction) {
    if (busy) return;
    setBusy(true); setError("");
    try { setOutcome(await actions.submit(item, draft, action)); }
    catch (reason) { setError(reason instanceof Error && reason.name !== "ZodError" ? reason.message : "请检查任务名称、分钟数及日期后重试。"); }
    finally { setBusy(false); }
  }
  return <li className="bg-white py-5">
    <div className="mb-4 space-y-2">
      <h2 className="break-words text-sm font-semibold leading-7 text-zinc-900">{item.title}</h2>
      <p className="break-words text-xs leading-5 text-zinc-500">{category} · {item.sourceNames.length ? `来源：${item.sourceNames.join("、")}` : item.ref.origin === "retest" ? "来自学习记录与技能线索，未关联材料" : "来自已保存的对话，未关联材料"}</p>
    </div>
    {outcome ? <div className="space-y-3" role="status">
      <p className="flex items-center gap-2 text-sm font-medium text-emerald-800"><Check size={16} aria-hidden="true" />{outcome.label}</p>
      {outcome.kind === "memory" ? <><p className="whitespace-pre-wrap break-words text-sm text-zinc-800">{outcome.memory.text}</p><Link className={secondaryButtonClass} href="/opening/assistant">打开助理的记忆管理<ArrowRight size={14} aria-hidden="true" /></Link></> : null}
      {outcome.kind === "task" || outcome.kind === "retest" ? <Link className={secondaryButtonClass} href={`/opening/today?task=${outcome.kind === "task" ? outcome.task.id : outcome.taskId}#task-${outcome.kind === "task" ? outcome.task.id : outcome.taskId}`}>查看生成的任务<ArrowRight size={14} aria-hidden="true" /></Link> : null}
    </div> : <>
      <ReviewFields item={item} draft={draft} onChange={setDraft} disabled={busy || Boolean(pending)} />
      {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
      {pending && !busy ? <p className="mt-2 text-xs leading-5 text-zinc-600">上次请求结果尚未确认。输入已保留，重试将发送相同请求；确认结果前请勿改为其他操作。</p> : null}
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled={busy || (pending !== undefined && pending.action !== "accept")} onClick={() => void decide("accept")} className={buttonClass}>{busy ? "正在处理…" : pending?.action === "accept" ? "重试接受" : item.proposal.kind === "memory" ? "确认记住" : "接受建议"}</button>
        <button type="button" disabled={busy || (pending !== undefined && pending.action !== "discard")} onClick={() => void decide("discard")} className={secondaryButtonClass}>{pending?.action === "discard" ? "重试忽略" : item.proposal.kind === "memory" ? "不记住" : "忽略建议"}</button>
      </div>
    </>}
  </li>;
}
