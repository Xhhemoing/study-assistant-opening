"use client";

import { useEffect, useState } from "react";
import type { SourceActionResult, SourceImpact, SourceRecord } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { createSourceActionsClient, SourceActionsError, type SourceActionsClient } from "./source-actions-client";

const client = createSourceActionsClient();
const danger = `${ui.secondary} border-red-200 text-red-700 hover:bg-red-50`;
export function sourceActionNotice(result: SourceActionResult): string {
  if (!result.deleted) return "已停止供后续模型请求使用。原件和课程引用已保留。";
  if (result.retryAfter) return `材料已移除；上传链接尚在有效期内，仍有 ${result.cleanupPending} 个已知对象待复查清理。请在 ${new Date(result.retryAfter).toLocaleString()} 后重试。`;
  return result.cleanupPending ? `材料已移除；仍有 ${result.cleanupPending} 个已知对象清理未完成，请重试。` : "材料已移除，已知对象已清理。";
}

export function SourceImpactSummary({ impact }: { impact: SourceImpact }) {
  return <div className="space-y-2 text-sm text-zinc-700">
    <p>本操作作用于这份材料及其全部课程引用。</p>
    {impact.courses.length ? <ul className="list-disc space-y-1 pl-5">
      {impact.courses.map(course => <li key={course.membershipId}>{course.title}{course.archivedAt ? "（已归档）" : ""}</li>)}
    </ul> : <p>这份材料目前没有课程引用。</p>}
    {impact.aiExcluded ? <p>当前已停止供模型使用。</p> : null}
  </div>;
}

export function SourceActionsPanel({ record, onClose, onChanged, onResult, api = client }: {
  record: SourceRecord; onClose: () => void; onChanged: () => Promise<void>;
  onResult: (result: SourceActionResult) => void; api?: SourceActionsClient;
}) {
  const [impact, setImpact] = useState<SourceImpact | null>(null);
  const [action, setAction] = useState<"exclude" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setImpact(null); setAction(null); setError(null);
    void api.impact(record.id).then(value => { if (live) setImpact(value); }, reason => {
      if (live) setError(reason instanceof Error ? reason.message : "影响信息读取失败，请重试。");
    });
    return () => { live = false; };
  }, [api, record.id, attempt]);

  async function confirm() {
    if (!impact || !action || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.act(record.id, { action, expectedVersion: impact.version, expectedMembershipIds: impact.courses.map(course => course.membershipId) });
      onResult(result);
      await onChanged();
      onClose();
    } catch (reason) {
      if (reason instanceof SourceActionsError && reason.status === 409) { setImpact(null); setAction(null); }
      setError(reason instanceof Error ? reason.message : "操作暂时未完成，请重试。");
    } finally { setBusy(false); }
  }

  return <section className="space-y-3 border-t border-zinc-200 bg-zinc-50 p-4" aria-label={`管理材料 ${record.name}`}>
    <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">管理材料</h4><button type="button" disabled={busy} className={ui.quiet} onClick={onClose}>关闭</button></div>
    {impact ? <>
      <SourceImpactSummary impact={impact} />
      {!action ? <div className="flex flex-wrap gap-2">
        <button type="button" className={ui.secondary} disabled={impact.aiExcluded} onClick={() => setAction("exclude")}>停止供模型使用</button>
        <button type="button" className={danger} onClick={() => setAction("delete")}>删除材料</button>
      </div> : <div className="space-y-3">
        <p className="text-sm text-zinc-700">{action === "exclude"
          ? "后续模型请求不再使用这份材料及可追溯的派生内容。原件、历史记录与课程引用保留；此处不提供重新允许使用。"
          : "将移除这份材料在所有课程中的引用，并清理已知原件和衍生图片。关联的模型回答、记忆、关联片段笔记及其修订正文不再显示，您输入的原文保留。已下载、外部及在途副本不属于本次清理范围。"}</p>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={action === "delete" ? danger : ui.primary} onClick={() => void confirm()}>{busy ? "处理中…" : action === "delete" ? "确认删除材料" : "确认停止供模型使用"}</button>
          <button type="button" disabled={busy} className={ui.quiet} onClick={() => setAction(null)}>取消</button></div>
      </div>}
    </> : !error ? <p role="status" className="text-sm text-zinc-600">正在读取跨课程影响…</p> : null}
    {error ? <div className="space-y-2"><p role="alert" className="text-sm text-amber-800">{error}</p>{!impact ? <button type="button" className={ui.secondary} onClick={() => setAttempt(value => value + 1)}>重新查看影响</button> : null}</div> : null}
  </section>;
}
