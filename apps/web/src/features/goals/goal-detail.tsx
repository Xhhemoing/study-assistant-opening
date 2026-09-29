"use client";

import { PageHeading, ui } from "../opening/design/ui";
import { Archive, ArrowLeft, Check, LoaderCircle, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStudyProvider } from "../../lib/data/react";
import { clampDailyMinutes, goalDraftFromGoal, normalizeGoalTitle, type GoalDraft } from "./goal-model";
import { DailyMinutesField, ExamDateField, ScenarioPicker, SubjectPicker } from "./goal-form-fields";

export interface GoalRequestGuard {
  mount(): void;
  unmount(): void;
  start(): number;
  canApply(version: number): boolean;
}

export function createGoalRequestGuard(): GoalRequestGuard {
  let mounted = false;
  let currentVersion = 0;
  return {
    mount: () => {
      mounted = true;
    },
    unmount: () => {
      mounted = false;
      currentVersion += 1;
    },
    start: () => {
      currentVersion += 1;
      return currentVersion;
    },
    canApply: (version) => mounted && version === currentVersion,
  };
}

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
  const requestGuard = useRef<GoalRequestGuard | null>(null);
  if (!requestGuard.current) requestGuard.current = createGoalRequestGuard();

  const loadGoal = useCallback(async () => {
    const guard = requestGuard.current as GoalRequestGuard;
    const version = guard.start();
    if (!provider) {
      setLoading(true);
      setDraft(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const nextGoal = await provider.getGoal(id);
      if (!guard.canApply(version)) return;
      setDraft(nextGoal ? goalDraftFromGoal(nextGoal) : null);
      if (!nextGoal) setError("找不到这个学习目标。");
    } catch {
      if (!guard.canApply(version)) return;
      setError("目标读取失败，请重试。");
    } finally {
      if (guard.canApply(version)) setLoading(false);
    }
  }, [id, provider]);

  useEffect(() => {
    const guard = requestGuard.current as GoalRequestGuard;
    guard.mount();
    void loadGoal();
    return () => guard.unmount();
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
    <main className="min-w-0 bg-white"><PageHeading title="目标详情" action={<Link className={ui.quiet} href="/learn/goals"><ArrowLeft aria-hidden="true" size={14} />返回目标列表</Link>} /><div className="mx-auto max-w-3xl space-y-6 px-5 py-5">

      {loading ? <p className="border-y border-zinc-200 py-8 text-sm text-zinc-500" role="status">正在读取目标…</p> : null}
      {!loading && error && !draft ? (
        <section className="space-y-3 border-y border-zinc-200 py-8" role="alert">
          <p className="text-sm text-red-700">{error}</p>
          <button className={ui.secondary} onClick={() => setReloadToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button>
        </section>
      ) : null}
      {!loading && draft ? (
        <>
          <form className="space-y-6" onSubmit={saveGoal}>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-zinc-900" htmlFor="goal-detail-title">目标名称</label>
              <input className="min-h-10 md:min-h-8 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200" id="goal-detail-title" maxLength={80} onChange={(event) => updateDraft("title", event.target.value)} value={draft.title} />
            </div>
            <ScenarioPicker onChange={(value) => updateDraft("scenario", value)} value={draft.scenario} />
            <ExamDateField onChange={(value) => updateDraft("examDate", value)} value={draft.examDate} />
            <SubjectPicker onChange={(value) => updateDraft("subjects", value)} value={draft.subjects} />
            <DailyMinutesField onChange={(value) => updateDraft("dailyMinutes", clampDailyMinutes(value))} value={draft.dailyMinutes} />
            {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
            <div className="flex justify-end border-t border-zinc-200 pt-5">
              <button className={ui.primary} disabled={saving} type="submit">
                {saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={16} /> : <Save aria-hidden="true" size={16} />}
                {saving ? "保存中" : "保存变更"}
              </button>
            </div>
          </form>
          <section className="space-y-3 border-t border-zinc-200 pt-6" aria-labelledby="archive-goal-heading">
            <div className="space-y-1"><h2 className="text-sm font-semibold text-zinc-900" id="archive-goal-heading">归档目标</h2><p className="text-xs text-zinc-500">归档后会从当前目标列表中隐藏。</p></div>
            {confirmArchive ? <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><p className="text-sm text-red-700">确认归档这个目标吗？</p><button className="inline-flex min-h-10 md:min-h-8 items-center justify-center gap-2 rounded-md bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50" disabled={archiving} onClick={() => void archiveGoal()} type="button"><Check aria-hidden="true" size={16} />确认归档</button><button className={ui.secondary} onClick={() => setConfirmArchive(false)} type="button">取消</button></div> : <button className="inline-flex min-h-10 md:min-h-8 items-center justify-center gap-2 rounded-md border border-red-200 px-3 text-sm text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" onClick={() => setConfirmArchive(true)} type="button"><Archive aria-hidden="true" size={16} />归档目标</button>}
          </section>
        </>
      ) : null}
    </div></main>
  );
}
