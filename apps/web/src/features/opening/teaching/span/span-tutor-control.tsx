"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { spanTutorGrantUpdateSchema, type SpanTutorGrantUpdate, type LearningPreferences, type OpeningAdaptivePrefsResponse } from "@aistudy/contracts";
import { createOpeningApi, OpeningApiError, type OpeningApi } from "../../client/api";
import { createCourseStateClient } from "../../courses/course-state-client";
import { TransitionLink as Link } from "../../v3/motion/view-transition";
import { ui } from "../../design/ui";
import { userFacingMessage } from "../../../../lib/user-facing-error";

type Snapshot = { courseId: string; preferences: OpeningAdaptivePrefsResponse; account: LearningPreferences; effective: LearningPreferences; archived: boolean };
const courseResponseSchema = z.object({ course: z.object({ id: z.string().uuid(), archivedAt: z.string().nullable() }) });
const memoryPending = new Map<string, SpanTutorGrantUpdate>();
const pendingKey = (courseId: string) => `aistudy:span-tutor-pending:${courseId}`;
function readPending(courseId: string): { patch: SpanTutorGrantUpdate | null; durable: boolean } {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(courseId));
    const parsed = raw && raw.length <= 2048 ? spanTutorGrantUpdateSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success && parsed.data.courseId === courseId) return { patch: parsed.data, durable: true };
    const patch = memoryPending.get(courseId) ?? null;
    return { patch, durable: patch === null };
  } catch { return { patch: memoryPending.get(courseId) ?? null, durable: false }; }
}
function savePending(patch: SpanTutorGrantUpdate): boolean {
  try { window.sessionStorage.setItem(pendingKey(patch.courseId), JSON.stringify(patch)); memoryPending.delete(patch.courseId); return true; }
  catch { memoryPending.set(patch.courseId, patch); return false; }
}
function clearPending(courseId: string) {
  memoryPending.delete(courseId);
  try { window.sessionStorage.removeItem(pendingKey(courseId)); } catch { /* A later read must still confirm the server revision. */ }
}

/** Course-local consent only: account switches, other courses and global autonomy are never patched. */
export function SpanTutorControl({ courseId: rawCourseId, api: supplied }: { courseId: string; api?: Pick<OpeningApi, "getAdaptivePrefs" | "patchAdaptivePrefs"> }) {
  const courseId = rawCourseId.toLowerCase();
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const stateClient = useMemo(() => createCourseStateClient(), []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [enabled, setEnabled] = useState(false), [minutes, setMinutes] = useState("30"), [expiresOn, setExpiresOn] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [mustReload, setMustReload] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [reloadToken, setReloadToken] = useState(0);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [durablePending, setDurablePending] = useState(true);
  const pendingPatch = useRef<SpanTutorGrantUpdate | null>(null);
  const epoch = useRef(0), saving = useRef(false);
  function apply(preferences: OpeningAdaptivePrefsResponse, id: string) {
    if (preferences.invalidStoredPrefs) throw new Error("已保存的授权暂时无法读取，请重新读取后再修改。");
    const grant = preferences.prefs.spanTutorGrants?.[id];
    const weekly = preferences.prefs.courseGoals[id]?.weeklyMinutes;
    setEnabled(grant?.enabled ?? false);
    setMinutes(String(grant?.dailyMinutes ?? (weekly ? Math.min(180, Math.max(10, Math.round(weekly / 7))) : 30)));
    setExpiresOn(grant?.expiresOn ?? "");
  }
  useEffect(() => {
    const current = ++epoch.current;
    setLoading(true); setSnapshot(null); setError(""); setNotice("");
    const recovered = readPending(courseId);
    pendingPatch.current = recovered.patch;
    setUnconfirmed(Boolean(recovered.patch)); setDurablePending(recovered.durable);
    if (recovered.patch) { setEnabled(recovered.patch.enabled); setMinutes(String(recovered.patch.dailyMinutes)); setExpiresOn(recovered.patch.expiresOn ?? ""); }
    void Promise.all([api.getAdaptivePrefs(), stateClient.getAccountPreferences(), stateClient.getPreferences(courseId),
      fetch(`/api/courses/${encodeURIComponent(courseId)}`, { cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error("课程状态暂时无法读取。");
        const result = courseResponseSchema.parse(await response.json());
        if (result.course.id !== courseId) throw new Error("课程状态与当前课程不一致。");
        return result.course;
      }),
    ]).then(([preferences, account, effective, course]) => {
      if (current !== epoch.current) return;
      if (preferences.invalidStoredPrefs) throw new Error("已保存的授权暂时无法读取，请重新读取后再修改。");
      setSnapshot({ courseId, preferences, account, effective, archived: Boolean(course.archivedAt) });
      const unresolved = pendingPatch.current;
      if (unresolved && unresolved.courseId === courseId && (preferences.prefs.spanTutorGrants?.[courseId]?.revision ?? 0) <= unresolved.expectedRevision) {
        setMustReload(true); setUnconfirmed(true);
        setError("授权保存待确认。页面仍显示先前设置，刚才的修改可能尚未保存；可继续查看，或再次确认这次授权。");
        return;
      }
      apply(preferences, courseId);
      clearPending(courseId);
      pendingPatch.current = null; setUnconfirmed(false);
      setMustReload(false);
    }).catch(reason => { if (current === epoch.current) { setMustReload(true); setError(userFacingMessage(reason, "授权读取失败，请重新读取。")); } })
      .finally(() => { if (current === epoch.current) setLoading(false); });
    return () => { epoch.current += 1; };
  }, [api, stateClient, courseId, reloadToken]);
  const current = snapshot?.courseId === courseId ? snapshot : null;
  const grant = current?.preferences.prefs.spanTutorGrants?.[courseId];
  const weekly = current?.preferences.prefs.courseGoals[courseId]?.weeklyMinutes;
  const suggestedMinutes = grant?.dailyMinutes ?? (weekly ? Math.min(180, Math.max(10, Math.round(weekly / 7))) : 30);
  const changed = enabled !== (grant?.enabled ?? false) || Number(minutes) !== suggestedMinutes || expiresOn !== (grant?.expiresOn ?? "");
  const blocked = loading || busy || mustReload || !current || (enabled && current.archived);
  async function save(retryOriginal = false) {
    if (saving.current || loading || !current || (retryOriginal ? !pendingPatch.current : blocked || !changed)) return;
    const patch = spanTutorGrantUpdateSchema.safeParse(retryOriginal ? pendingPatch.current : { courseId, enabled, dailyMinutes: Number(minutes), expiresOn: expiresOn || null, expectedRevision: grant?.revision ?? 0 });
    if (!patch.success) { setError("请填写 10–180 分钟的整数预算和有效截止日期。"); return; }
    const requestEpoch = epoch.current;
    pendingPatch.current = patch.data;
    setDurablePending(savePending(patch.data));
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.patchAdaptivePrefs({ spanTutorGrant: patch.data });
      if (requestEpoch !== epoch.current) return;
      const saved = result.prefs.spanTutorGrants?.[courseId];
      if (result.invalidStoredPrefs || !saved || saved.revision <= patch.data.expectedRevision || saved.enabled !== patch.data.enabled
        || saved.dailyMinutes !== patch.data.dailyMinutes || saved.expiresOn !== patch.data.expiresOn) throw new Error("服务器未返回本次授权的完整确认。");
      apply(result, courseId);
      clearPending(courseId);
      pendingPatch.current = null; setUnconfirmed(false); setMustReload(false);
      setSnapshot({ ...current, preferences: result });
      setNotice(saved.enabled ? "本课程导师试用设置已保存。账号和课程总开关仍然生效。" : "本课程导师试用已关闭，已有学习记录和任务保留。");
    } catch (reason) {
      if (requestEpoch === epoch.current) {
        if (!retryOriginal && reason instanceof OpeningApiError && reason.status >= 400 && reason.status < 500) { clearPending(courseId); pendingPatch.current = null; }
        setUnconfirmed(Boolean(pendingPatch.current)); setMustReload(true);
        setError(`保存结果未确认。${userFacingMessage(reason, "请先重新读取授权，再决定是否提交。")}`);
      }
    } finally { saving.current = false; if (requestEpoch === epoch.current) setBusy(false); }
  }
  return <details className="rounded-lg border border-line bg-surface px-4 py-2">
    <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium text-text-2">本课程导师试用{unconfirmed ? " · 授权保存待确认" : current ? grant?.enabled ? " · 已保存开启" : " · 未开启" : ""}</summary>
    <div className="space-y-3 pb-3 text-sm">
      <p className="text-xs leading-6 text-text-2">允许根据学习记录选择本课程的 span 活动，并自动安排后续复测。日预算由练习与复测共用；仅适用于未归档的本课程，不扩展到其他课程或目标。</p>
      {!durablePending ? <p role="status" className="text-xs leading-6 text-warn">浏览器无法保留这次待确认的授权。请保留本页继续查看；刷新或关闭后将无法找回这次待确认的授权，也不能因此认为刚才的授权已保存或已取消。</p> : null}
      {loading ? <p role="status" className="text-xs text-text-3">正在读取授权与课程开关…</p> : null}
      {current ? <>
        <p className="text-xs leading-6 text-text-2">账号自动评价：{current.account.assessmentEnabled ? "开启" : "关闭"}；账号补测建议：{current.account.retestSuggestionsEnabled ? "开启" : "关闭"}。课程生效：自动评价{current.effective.assessmentEnabled ? "开启" : "关闭"}、补测建议{current.effective.retestSuggestionsEnabled ? "开启" : "关闭"}。</p>
        {!current.effective.assessmentEnabled || !current.effective.retestSuggestionsEnabled ? <p className="text-xs text-warn">试用设置不会打开已关闭的总开关。<Link href="/opening/settings" className={ui.quiet}>查看账号设置</Link></p> : null}
        {current.archived ? <p role="status" className="text-xs text-warn">课程已归档，导师试用不生效；请先恢复课程。仍可关闭已有授权。</p> : null}
        {weekly ? <p className="text-xs text-text-3">课程已有预算：每周 {weekly} 分钟。{!grant ? "下方日预算按周预算平均建议，可自行调整。" : ""}</p> : null}
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" disabled={busy || mustReload} checked={enabled} onChange={event => { setEnabled(event.target.checked); setNotice(""); }} />开启本课程导师试用（取消勾选可关闭）</label>
        <label className="block text-xs text-text-2">每日预算（分钟）<input aria-label="导师每日预算（分钟）" className={`${ui.input} mt-1 max-w-40`} type="number" min={10} max={180} step={1} disabled={busy || mustReload} value={minutes} onChange={event => { setMinutes(event.target.value); setNotice(""); }} /></label>
        <label className="block text-xs text-text-2">授权截止日期（可选）<input aria-label="导师授权截止日期" className={`${ui.input} mt-1 max-w-52`} type="date" disabled={busy || mustReload} value={expiresOn} onChange={event => { setExpiresOn(event.target.value); setNotice(""); }} /></label>
        <p className="text-xs text-text-3">当前授权版本：{grant?.revision ?? 0}{expiresOn ? `；有效至 ${expiresOn}（工作区日期）` : "；未设置截止日期"}</p>
      </> : null}
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={blocked || !changed} onClick={() => void save()}>{busy ? "正在保存…" : "确认导师试用设置"}</button>{unconfirmed ? <button type="button" className={ui.secondary} disabled={busy || loading || !current} onClick={() => void save(true)}>重新确认原授权</button> : null}<button type="button" className={ui.quiet} disabled={busy || loading} onClick={() => setReloadToken(value => value + 1)}>重新读取授权</button></div>
      {error ? <p role="alert" className="text-xs leading-6 text-danger">{error}</p> : null}
      {notice ? <p role="status" className="text-xs leading-6 text-text-2">{notice}</p> : null}
    </div>
  </details>;
}
