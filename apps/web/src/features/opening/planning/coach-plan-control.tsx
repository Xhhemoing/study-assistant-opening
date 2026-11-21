"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachPlanAcceptance, PlanDraft } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

type CoachApi = Pick<OpeningApi, "getAdaptivePrefs" | "getCoachAcceptance" | "acceptCoachPlan" | "undoCoachPlan">;
export function CoachPlanControl({ date, draft, api, onChanged, onPrepare, settingsRevision = 0 }: {
  date: string; draft: PlanDraft | null; api: CoachApi; onChanged: () => void | Promise<void>;
  onPrepare?: () => Promise<void>; settingsRevision?: number;
}) {
  const [summary, setSummary] = useState<CoachPlanAcceptance | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);
  const epoch = useRef(0), busy = useRef(false);
  const undoKeys = useRef(new Map<string, string>());

  const read = useCallback(async () => {
    const request = ++epoch.current;
    setPending(true); setError(""); setConfirmUndo(false); setSummary(null);
    try {
      const [prefs, acceptance] = await Promise.all([api.getAdaptivePrefs(), api.getCoachAcceptance(date)]);
      if (request !== epoch.current) return;
      setEnabled(!prefs.invalidStoredPrefs && prefs.prefs.autonomy === "coach" && prefs.prefs.coachAutoAcceptEnabled === true);
      setSummary(acceptance);
    } catch (reason) {
      if (request === epoch.current) setError(userFacingMessage(reason, "教练安排结果需要核对，请重新读取。"));
    } finally { if (request === epoch.current) setPending(false); }
  }, [api, date]);

  useEffect(() => { void read(); return () => { epoch.current += 1; }; }, [read, settingsRevision]);

  const eligibleDraft = draft?.origin === "auto_draft" && draft.status === "draft" ? draft : null;

  async function arrange() {
    if (busy.current || pending || !enabled || summary || error) return;
    busy.current = true;
    const request = ++epoch.current;
    setPending(true);
    try {
      if (!eligibleDraft) {
        await onPrepare?.();
        return;
      }
      const acceptance = await api.getCoachAcceptance(date);
      if (request !== epoch.current) return;
      if (acceptance) { setSummary(acceptance); return; }
      const { id, version } = eligibleDraft;
      const result = await api.acceptCoachPlan({ draftId: id, expectedDraftVersion: version, clientKey: `coach:${id}:${version}` });
      if (request !== epoch.current) return;
      setSummary(result.acceptance);
      await onChanged();
    } catch (reason) {
      if (request === epoch.current) setError(userFacingMessage(reason, "教练安排结果需要核对，请重新读取。"));
    } finally { busy.current = false; if (request === epoch.current) setPending(false); }
  }

  async function undo() {
    if (busy.current || pending || !summary) return;
    busy.current = true;
    const request = ++epoch.current;
    setPending(true); setError("");
    try {
      const undoKey = undoKeys.current.get(summary.clientKey) ?? crypto.randomUUID();
      undoKeys.current.set(summary.clientKey, undoKey);
      await api.undoCoachPlan({ date, acceptanceClientKey: summary.clientKey, expectedAcceptedVersion: summary.acceptedVersion,
        clientKey: undoKey });
      if (request !== epoch.current) return;
      setConfirmUndo(false); setSummary({ ...summary, undone: true, undoAvailable: false });
      await onChanged();
    } catch (reason) {
      if (request === epoch.current) { setConfirmUndo(false); setError(userFacingMessage(reason, "撤销结果需要核对，请重新读取。")); }
    } finally { busy.current = false; if (request === epoch.current) setPending(false); }
  }

  if (!summary && !enabled && !error) return null;
  return <section className="mx-4 my-3 space-y-2.5 rounded-card border border-line bg-surface-2/60 p-4 shadow-card" aria-label="教练安排摘要">
    {summary ? <><p className="text-xs leading-6 tabular-nums text-text-2">{summary.undone ? "这次教练安排已撤销，学习记录保留。" : `教练安排了${summary.scheduledMinutes}分钟，新增${summary.createdTaskIds.length}项任务。`}</p>
      {!summary.undone && summary.undoAvailable ? <button type="button" className={secondaryButtonClass} disabled={pending || Boolean(error)} onClick={() => setConfirmUndo(true)}>撤销这次安排</button> : null}
      {!summary.undone && !summary.undoAvailable ? <p className="text-xs text-text-3">安排已开始或已有后续调整，保留当前计划；可手动调整尚未完成的任务。</p> : null}
    </> : <><p className="text-xs text-text-2">{pending ? "正在核对教练安排…" : "教练已启用；今日已有确认计划时仍需手动调整。"}</p>
      {enabled && (eligibleDraft || onPrepare) && !error ? <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void arrange()}>
        {eligibleDraft ? "按预算安排今日草案" : "生成今日草案"}
      </button> : null}</>}
    {confirmUndo ? <div className="space-y-2 rounded-xl border border-line bg-surface p-3"><p className="text-xs leading-6 text-text-2">仅在这次安排尚未开始、任务未改动时撤销。只关闭教练新建的任务，保留你的原有任务。</p><div className="flex flex-wrap gap-2"><button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void undo()}>确认撤销</button><button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => setConfirmUndo(false)}>保留安排</button></div></div> : null}
    {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
    {error ? <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void read()}>重新核对安排</button> : null}
  </section>;
}
