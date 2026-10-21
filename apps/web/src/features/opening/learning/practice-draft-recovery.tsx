"use client";

import Link from "next/link";
import { useRef, useState } from "react";

/** Keep the raw answer accessible even when the old material can no longer be resumed. */
export function PracticeDraftRecovery({ courseId, answer, pending, onResume }: {
  courseId: string; answer: string; pending: boolean; onResume: () => void;
}) {
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const [copyNotice, setCopyNotice] = useState("");
  async function copyAnswer() {
    answerRef.current?.select();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(answer);
      setCopyNotice("已复制原答案。");
    } catch { setCopyNotice("已选中原答案，请按 Ctrl+C 或 ⌘C 复制。"); }
  }
  return <div className="space-y-3">
    <p className="text-sm text-text-2" role="status">已找回本次练习草稿。继续原练习后读取最新记录，原答案保持不变。</p>
    {answer ? <label className="block text-sm text-text-2">原答案（可选中复制）
      <textarea ref={answerRef} readOnly value={answer} rows={4} className="mt-1 w-full rounded border border-text-3 bg-bg px-3 py-2" />
    </label> : null}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={pending} onClick={onResume} className="rounded bg-ink px-3 py-2 text-sm text-on-ink disabled:opacity-50">{pending ? "正在读取…" : "继续此练习"}</button>
      {answer ? <button type="button" onClick={() => void copyAnswer()} className="rounded border border-line px-3 py-2 text-sm text-text">复制原答案</button> : null}
      <Link href={`/opening/courses/${courseId}#course-learning-records`} className="text-sm text-accent underline underline-offset-4">查看课程历史</Link>
    </div>
    {copyNotice ? <p className="text-xs text-text-2" role="status">{copyNotice}</p> : null}
  </div>;
}

/** Switching keeps the old answer/request intact; server records are re-read after resuming. */
export function PracticeDraftShelf({ continuity, allowAnother = true }: {
  continuity: import("./practice-draft").PracticeContinuity; allowAnother?: boolean;
}) {
  const { draft, drafts, ready, loadError, switchError, reload, restore, startAnother } = continuity;
  const archived = drafts.filter(value => value.id !== draft.id);
  const hasCurrentWork = Boolean(draft.start || draft.submission || draft.fields.answer || draft.fields.stem || draft.fields.sourceId || draft.fields.skillLabel);
  return <div className="space-y-3">
    {loadError ? <div className="space-y-2" role="alert"><p className="text-sm text-danger">{loadError}</p><button type="button" onClick={reload} className="rounded border border-line px-3 py-2 text-sm">重新读取草稿</button></div> : null}
    {switchError ? <p className="text-sm text-danger" role="alert">{switchError}</p> : null}
    {ready && allowAnother && hasCurrentWork ? <button type="button" onClick={() => startAnother()} className="rounded border border-line px-3 py-2 text-sm text-text">保留此草稿，开始其他练习</button> : null}
    {ready && archived.length ? <details className="rounded border border-line px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-text">保留的练习草稿（{archived.length}）</summary>
      <p className="mt-2 text-xs leading-6 text-text-3">可随时切回原草稿；当前答案也会保留。切换不会重新提交答案。</p>
      <ul className="mt-3 space-y-4">{archived.map((saved, index) => <li key={saved.id} className="space-y-2 border-t border-line pt-3">
        <p className="text-sm font-medium text-text">草稿 {index + 1} · {saved.fields.skillLabel || "矩阵练习"}{saved.fields.skillLabel ? "" : ` · 第 ${saved.fields.matrixVariant + 1} 组`}</p>
        {saved.fields.stem ? <p className="whitespace-pre-wrap break-words text-xs text-text-2">{saved.fields.stem}</p> : null}
        {saved.fields.answer ? <label className="block text-xs text-text-2">保留的原答案（可选中复制）<textarea readOnly value={saved.fields.answer} rows={3} className="mt-1 w-full rounded border border-text-3 bg-bg px-3 py-2 text-sm" /></label> : <p className="text-xs text-text-3">尚未填写答案，已保留原练习和保存请求。</p>}
        <button type="button" onClick={() => restore(saved.id)} className="rounded border border-line px-3 py-2 text-sm text-text">切换到此草稿</button>
      </li>)}</ul>
    </details> : null}
  </div>;
}
