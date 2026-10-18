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
    <p className="text-sm text-zinc-700" role="status">已找回本次练习草稿。继续原练习后读取最新记录，原答案保持不变。</p>
    {answer ? <label className="block text-sm text-zinc-700">原答案（可选中复制）
      <textarea ref={answerRef} readOnly value={answer} rows={4} className="mt-1 w-full rounded border border-zinc-200 bg-zinc-50 px-3 py-2" />
    </label> : null}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={pending} onClick={onResume} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "正在读取…" : "继续此练习"}</button>
      {answer ? <button type="button" onClick={() => void copyAnswer()} className="rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-800">复制原答案</button> : null}
      <Link href={`/opening/courses/${courseId}#course-learning-records`} className="text-sm text-emerald-800 underline underline-offset-4">查看课程历史</Link>
    </div>
    {copyNotice ? <p className="text-xs text-zinc-600" role="status">{copyNotice}</p> : null}
  </div>;
}
