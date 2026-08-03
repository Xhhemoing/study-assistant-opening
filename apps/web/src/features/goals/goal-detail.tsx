"use client";

import { Archive, ArrowLeft, Check, LoaderCircle, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useStudyProvider } from "../../lib/data/react";
import { clampDailyMinutes, goalDraftFromGoal, normalizeGoalTitle, type GoalDraft } from "./goal-model";
import { DailyMinutesField, ExamDateField, ScenarioPicker, SubjectPicker } from "./goal-form-fields";

export function GoalDetail({ id }: { id: string }) {
  const router = useRouter();
  const provider = useStudyProvider();
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const loadGoal = useCallback(async () => {
    if (!provider) {
      setLoading(true);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const nextGoal = await provider.getGoal(id);
      setDraft(nextGoal ? goalDraftFromGoal(nextGoal) : null);
      if (!nextGoal) setError("找不到这个学习目标。");
    } catch {
      setError("目标读取失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, [id, provider]);

  useEffect(() => {
    void loadGoal();
  }, [loadGoal, reloadToken]);

  function updateDraft<K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function saveGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !draft || saving) return;
    const title = normalizeGoalTitle(draft.title);
    if (!title) {
      setError("请填写目标名称。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nextGoal = await provider.updateGoal(id, { ...draft, title, dailyMinutes: clampDailyMinutes(draft.dailyMinutes) });
      setDraft(goalDraftFromGoal(nextGoal));
    } catch {
      setError("目标保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  async function archiveGoal() {
    if (!provider || archiving) return;
    setArchiving(true);
    setError("");
    try {
      await provider.archiveGoal(id);
      router.replace("/learn/goals");
    } catch {
      setError("目标归档失败，请重试。");
      setArchiving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-3 border-b border-line pb-6">
        <Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/goals"><ArrowLeft aria-hidden="true" size={16} />返回目标列表</Link>
        <div className="space-y-1">
          <p className="text-xs text-text-dim">学习空间 / 目标详情</p>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">目标详情</h1>
        </div>
      </header>

      {loading ? <p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在读取目标…</p> : null}
      {!loading && error && !draft ? (
        <section className="space-y-3 border-y border-line py-8" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button>
        </section>
      ) : null}
      {!loading && draft ? (
        <>
          <form className="space-y-8" onSubmit={saveGoal}>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-text" htmlFor="goal-detail-title">目标名称</label>
              <input className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="goal-detail-title" maxLength={80} onChange={(event) => updateDraft("title", event.target.value)} value={draft.title} />
            </div>
            <ScenarioPicker onChange={(value) => updateDraft("scenario", value)} value={draft.scenario} />
            <ExamDateField onChange={(value) => updateDraft("examDate", value)} value={draft.examDate} />
            <SubjectPicker onChange={(value) => updateDraft("subjects", value)} value={draft.subjects} />
            <DailyMinutesField onChange={(value) => updateDraft("dailyMinutes", clampDailyMinutes(value))} value={draft.dailyMinutes} />
            {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
            <div className="flex justify-end border-t border-line pt-5">
              <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={saving} type="submit">
                {saving ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <Save aria-hidden="true" size={16} />}
                {saving ? "保存中" : "保存变更"}
              </button>
            </div>
          </form>
          <section className="space-y-3 border-t border-line pt-6" aria-labelledby="archive-goal-heading">
            <div className="space-y-1"><h2 className="text-sm font-semibold text-text" id="archive-goal-heading">归档目标</h2><p className="text-xs text-text-dim">归档后会从当前目标列表中隐藏。</p></div>
            {confirmArchive ? <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><p className="text-sm text-danger">确认归档这个目标吗？</p><button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-danger px-3 text-sm font-semibold text-white hover:bg-danger/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-50" disabled={archiving} onClick={() => void archiveGoal()} type="button"><Check aria-hidden="true" size={16} />确认归档</button><button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setConfirmArchive(false)} type="button">取消</button></div> : <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-danger/40 px-3 text-sm text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger" onClick={() => setConfirmArchive(true)} type="button"><Archive aria-hidden="true" size={16} />归档目标</button>}
          </section>
        </>
      ) : null}
    </main>
  );
}
