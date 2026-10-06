"use client";

import type { LearningPreferences } from "@aistudy/contracts";
import { LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { Check, LoaderCircle, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { GuidanceMode } from "../../lib/data/types";
import { useStudyProvider } from "../../lib/data/react";
import { GuidanceModePicker, type GuidanceModeDraft } from "../guidance-settings/guidance-mode-picker";
import { defaultGuidanceMode } from "../guidance-settings/guidance-mode-model";
import { DiagnosticsPanel } from "./diagnostics-panel";
import { AiSettingsPanel } from "./ai-settings-panel";
import { ProviderSettingsPanel } from "./provider-settings-panel";
import { DingTalkConnectionsPanel } from "./dingtalk-connections-panel";

type WorkspaceEntry = "learn" | "explore" | "library";
const entries: Array<{ value: WorkspaceEntry; label: string }> = [
  { value: "learn", label: "目标学习" },
  { value: "explore", label: "自由探索" },
  { value: "library", label: "知识库" },
];
const guidanceModes: Array<{ value: GuidanceMode; label: string }> = [
  { value: "direct", label: "直接讲解" },
  { value: "balanced", label: "平衡" },
  { value: "socratic", label: "苏格拉底式追问" },
];
const disabledLearningPreferences: LearningPreferences = {
  assessmentEnabled: false,
  retestSuggestionsEnabled: false,
  automaticRemindersEnabled: false,
};
const learningSwitches: Array<{ key: keyof LearningPreferences; label: string }> = [
  { key: "assessmentEnabled", label: "自动评价" },
  { key: "retestSuggestionsEnabled", label: "补测建议" },
  { key: "automaticRemindersEnabled", label: "自动学习提醒" },
];

export function SettingsView() {
  const router = useRouter();
  const provider = useStudyProvider();
  const [defaultEntry, setDefaultEntry] = useState<WorkspaceEntry | null>(null);
  const [guidanceMode, setGuidanceMode] = useState<GuidanceMode>("balanced");
  const [learningPreferences, setLearningPreferences] = useState<LearningPreferences>(disabledLearningPreferences);
  const [autonomyDraft, setAutonomyDraft] = useState<GuidanceModeDraft>(() => ({
    mode: defaultGuidanceMode(),
    protectedSlots: [],
  }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadSettings = useCallback(async () => {
    if (!provider) {
      setLoading(true);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [preferenceResponse, mode] = await Promise.all([
        fetch("/api/workspace/preferences", { cache: "no-store" }),
        provider.getGuidanceMode(),
      ]);
      if (!preferenceResponse.ok) throw new Error();
      const body = await preferenceResponse.json() as { defaultEntry?: WorkspaceEntry | null; learningPreferences?: LearningPreferences };
      setDefaultEntry(body.defaultEntry ?? null);
      setLearningPreferences(body.learningPreferences ?? disabledLearningPreferences);
      setGuidanceMode(mode);
    } catch {
      setError("设置暂时无法读取，请重试。");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function saveEntry() {
    if (!defaultEntry || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/workspace/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultEntry }) });
      if (!response.ok) throw new Error();
      setNotice("默认入口已保存。");
    } catch {
      setError("默认入口保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  async function saveLearningPreferences() {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/workspace/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learningPreferences }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { learningPreferences: LearningPreferences };
      setLearningPreferences(body.learningPreferences);
      setNotice("学习偏好已保存。");
    } catch {
      setError("学习偏好保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  async function saveGuidanceMode(value: GuidanceMode) {
    if (!provider) return;
    setGuidanceMode(value);
    setError("");
    try {
      await provider.setGuidanceMode(value);
      setNotice("指导模式已保存。");
    } catch {
      setError("指导模式保存失败，请重试。");
    }
  }

  async function resetDemoData() {
    if (!provider || !window.confirm("确定要重置当前用户的演示数据吗？")) return;
    setSaving(true);
    setError("");
    try {
      await provider.resetDemoData();
      router.refresh();
      window.location.reload();
    } catch {
      setError("演示数据重置失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-w-0 bg-white">
      <PageHeading title="设置" description="调整 AI 模型路由、工作区入口、学习方式和数据管理。" />
      <div className="mx-auto max-w-4xl space-y-6 px-5 py-5">
        <AiSettingsPanel />
        <ProviderSettingsPanel />
        <DingTalkConnectionsPanel />
        {loading ? <LoadingRows label="正在读取设置" /> : null}
        {error ? <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3" role="alert"><p className="text-sm text-red-700">{error}</p><button className={ui.secondary} onClick={() => void loadSettings()} type="button"><RefreshCw aria-hidden="true" size={14} />重新读取</button></div> : null}
        {!loading ? <>
          <section className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="default-entry-heading">
            <div><h2 className="text-sm font-medium text-zinc-900" id="default-entry-heading">默认入口</h2><p className="mt-1 text-xs leading-6 text-zinc-500">打开工作区首页时进入这里。</p></div>
            <div className="space-y-3"><div className="divide-y divide-zinc-100">{entries.map((entry) => <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-zinc-700 focus-within:ring-2 focus-within:ring-emerald-700 has-[:checked]:bg-emerald-50 has-[:checked]:text-emerald-800" key={entry.value}><input checked={defaultEntry === entry.value} className="size-4 accent-emerald-700" name="default-entry" onChange={() => setDefaultEntry(entry.value)} type="radio" />{entry.label}</label>)}</div><button className={ui.primary} disabled={!defaultEntry || saving} onClick={() => void saveEntry()} type="button">{saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}保存入口</button></div>
          </section>
          <section className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="guidance-heading">
            <div><h2 className="text-sm font-medium text-zinc-900" id="guidance-heading">指导模式</h2><p className="mt-1 text-xs leading-6 text-zinc-500">影响探索中的模拟回复风格。</p></div>
            <label className="block"><span className="sr-only">指导模式</span><select className={ui.input} onChange={(event) => void saveGuidanceMode(event.target.value as GuidanceMode)} value={guidanceMode}>{guidanceModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label>
          </section>
          <section className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="learning-preferences-heading">
            <div><h2 className="text-sm font-medium text-zinc-900" id="learning-preferences-heading">学习偏好</h2></div>
            <div className="space-y-3">
              <div className="divide-y divide-zinc-100">{learningSwitches.map(({ key, label }) => (
                <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-zinc-700 focus-within:ring-2 focus-within:ring-emerald-700" key={key}>
                  <span>{label}</span><input checked={learningPreferences[key]} className="size-4 accent-emerald-700" disabled={key !== "assessmentEnabled" && !learningPreferences.assessmentEnabled} onChange={(event) => setLearningPreferences((current) => key === "assessmentEnabled" && !event.target.checked ? disabledLearningPreferences : { ...current, [key]: event.target.checked })} type="checkbox" />
                </label>
              ))}</div>
              <button className={ui.primary} disabled={saving} onClick={() => void saveLearningPreferences()} type="button">{saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}保存学习偏好</button>
            </div>
          </section>
          <section className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="autonomy-heading">
            <div><h2 className="text-sm font-medium text-zinc-900" id="autonomy-heading">计划自主权</h2><p className="mt-1 text-xs leading-6 text-zinc-500">预览自动调整规则和探索时段；当前选择仅保留在此页面。</p></div><GuidanceModePicker value={autonomyDraft} onChange={setAutonomyDraft} />
          </section>
          <section className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="export-heading">
            <div><h2 className="text-sm font-medium text-zinc-900" id="export-heading">数据导出</h2><p className="mt-1 text-xs leading-6 text-zinc-500">下载内容投影或管理原生内容备份。</p></div><div className="space-y-3"><p className="text-sm leading-7 text-zinc-600">Markdown / Anki 是内容投影；原生备份可恢复笔记、课程、卡片等原生数据，不包含材料原件、助理对话与练习进度。具体范围见导出与备份页。</p><Link className={ui.secondary} href="/settings/export">打开导出与备份</Link></div>
          </section>
          <section className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="demo-heading">
            <div><h2 className="text-sm font-medium text-zinc-900" id="demo-heading">演示数据</h2><p className="mt-1 text-xs leading-6 text-zinc-500">只重置当前账号的本地 mock 学习数据。</p></div><div><button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-red-200 px-3 text-xs text-red-700 transition-colors duration-150 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50 motion-reduce:transition-none md:min-h-8" disabled={saving} onClick={() => void resetDemoData()} type="button"><Check aria-hidden="true" size={14} />重置演示数据</button></div>
          </section>
          <DiagnosticsPanel provider={provider} />
        </> : null}
        {notice ? <p className="text-sm text-emerald-700" role="status">{notice}</p> : null}
      </div>
    </main>
  );
}
