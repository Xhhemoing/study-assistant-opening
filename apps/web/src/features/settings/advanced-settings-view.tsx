"use client";

import { LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { ArrowLeft, LoaderCircle, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GuidanceModePicker, type GuidanceModeDraft } from "../guidance-settings/guidance-mode-picker";
import { defaultGuidanceMode } from "../guidance-settings/guidance-mode-model";
import { AiSettingsPanel } from "./ai-settings-panel";
import { ProviderSettingsPanel } from "./provider-settings-panel";
import { QuickSetupPanel } from "./quick-setup-panel";
import { PlanFeedbackPanel } from "../opening/planning/plan-feedback-panel";
import {
  fetchWorkspacePreferences,
  putWorkspacePreferences,
  workspaceEntries,
  type WorkspaceEntry,
} from "./settings-shared";

export function AdvancedSettingsView({ basePath = "/settings" }: { basePath?: string } = {}) {
  const [modelRevision, setModelRevision] = useState(0);
  const [defaultEntry, setDefaultEntry] = useState<WorkspaceEntry | null>(null);
  const [autonomyDraft, setAutonomyDraft] = useState<GuidanceModeDraft>(() => ({
    mode: defaultGuidanceMode(),
    protectedSlots: [],
  }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await fetchWorkspacePreferences();
      setDefaultEntry(body.defaultEntry ?? null);
    } catch {
      setError("设置暂时无法读取，请重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function saveEntry() {
    if (!defaultEntry || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await putWorkspacePreferences({ defaultEntry });
      setNotice("默认入口已保存。");
    } catch {
      setError("默认入口保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-w-0 bg-white">
      <PageHeading
        title="高级设置"
        description="每日额度与 AI 模型、默认入口、计划自主权、导出与备份。学习闭环相关项在主设置页。"
        action={<Link className={ui.quiet} href={basePath}><ArrowLeft aria-hidden="true" size={14} />返回设置</Link>}
      />
      <div className="mx-auto max-w-4xl space-y-6 px-5 py-5">
        <QuickSetupPanel basePath={basePath} onConfigured={() => setModelRevision(current => current + 1)} />
        <AiSettingsPanel key={`ai-${modelRevision}`} />
        <ProviderSettingsPanel key={`providers-${modelRevision}`} />
        {basePath === "/opening/settings" ? <PlanFeedbackPanel /> : null}
        {error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3" role="alert">
            <p className="text-sm text-red-700">{error}</p>
            <button className={ui.secondary} onClick={() => void loadSettings()} type="button">
              <RefreshCw aria-hidden="true" size={14} />重新读取
            </button>
          </div>
        ) : null}
        <details className="group border-b border-zinc-200 pb-4" data-advanced-fold="entry-explore">
          <summary className="cursor-pointer list-none py-2 text-sm font-medium text-zinc-900 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">默认入口与探索相关<span className="text-xs font-normal text-zinc-500 group-open:hidden">（已折叠）</span></span>
          </summary>
          <div className="mt-3 space-y-6">
            {loading ? <LoadingRows label="正在读取设置" /> : null}
            {!loading ? (
              <>
                <section className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="default-entry-heading">
                  <div>
                    <h2 className="text-sm font-medium text-zinc-900" id="default-entry-heading">默认入口</h2>
                    <p className="mt-1 text-xs leading-6 text-zinc-500">打开工作区首页时进入这里。自由探索等非闭环入口仅作备选，不作为推荐首页。</p>
                  </div>
                  <div className="space-y-3">
                    <div className="divide-y divide-zinc-100">
                      {workspaceEntries.map((entry) => (
                        <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-zinc-700 focus-within:ring-2 focus-within:ring-emerald-700 has-[:checked]:bg-emerald-50 has-[:checked]:text-emerald-800" key={entry.value}>
                          <input checked={defaultEntry === entry.value} className="size-4 accent-emerald-700" name="default-entry" onChange={() => setDefaultEntry(entry.value)} type="radio" />
                          {entry.label}{entry.value === "explore" ? <span className="text-xs text-zinc-400">（备选，非推荐）</span> : null}
                        </label>
                      ))}
                    </div>
                    <button className={ui.primary} disabled={!defaultEntry || saving} onClick={() => void saveEntry()} type="button">
                      {saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}
                      保存入口
                    </button>
                  </div>
                </section>
                <section className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="autonomy-heading">
                  <div>
                    <h2 className="text-sm font-medium text-zinc-900" id="autonomy-heading">计划自主权</h2>
                    <p className="mt-1 text-xs leading-6 text-zinc-500">预览自动调整规则和探索时段；当前选择仅保留在此页面。</p>
                  </div>
                  <GuidanceModePicker value={autonomyDraft} onChange={setAutonomyDraft} />
                </section>
              </>
            ) : null}
          </div>
        </details>
        <details className="group border-b border-zinc-200 pb-4" data-advanced-fold="export">
          <summary className="cursor-pointer list-none py-2 text-sm font-medium text-zinc-900 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">导出与备份<span className="text-xs font-normal text-zinc-500 group-open:hidden">（已折叠）</span></span>
          </summary>
          <section className="mt-3 grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="export-heading">
            <div>
              <h2 className="text-sm font-medium text-zinc-900" id="export-heading">数据导出</h2>
              <p className="mt-1 text-xs leading-6 text-zinc-500">下载内容投影或管理原生内容备份。</p>
            </div>
            <div className="space-y-3">
              <p className="text-sm leading-7 text-zinc-600">Markdown / Anki 是内容投影；原生备份可恢复笔记、课程、卡片等原生数据，不包含材料原件、助理对话与练习进度。具体范围见导出与备份页。</p>
              <Link className={ui.secondary} href={`${basePath}/export`}>打开导出与备份</Link>
            </div>
          </section>
        </details>
        <details className="group border-b border-zinc-200 pb-4" data-advanced-fold="danger">
          <summary className="cursor-pointer list-none py-2 text-sm font-medium text-zinc-900 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">危险操作<span className="text-xs font-normal text-zinc-500 group-open:hidden">（已折叠）</span></span>
          </summary>
          <section className="mt-3 grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="demo-heading">
            <div>
              <h2 className="text-sm font-medium text-zinc-900" id="demo-heading">演示数据</h2>
              <p className="mt-1 text-xs leading-6 text-zinc-500">生产构建不提供本地 mock 学习数据重置。</p>
            </div>
            <p className="text-sm leading-7 text-zinc-600" role="status" data-testid="demo-reset-unavailable">
              演示数据重置仅保留在非生产预览入口；此页不会加载假学习数据。
            </p>
          </section>
        </details>
        <details className="group border-b border-zinc-200 pb-4" data-advanced-fold="developer">
          <summary className="cursor-pointer list-none py-2 text-sm font-medium text-zinc-900 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">开发者<span className="text-xs font-normal text-zinc-500 group-open:hidden">（已折叠）</span></span>
          </summary>
          <div className="mt-3">
            <p className="text-sm leading-7 text-zinc-600" role="status" data-testid="mock-diagnostics-unavailable">
              基于 mock provider 的诊断面板已从发布路径移除。DB/provider 不可用时请查看真实错误或空态，不会回退到演示数据。
            </p>
          </div>
        </details>
        {notice ? <p className="text-sm text-emerald-700" role="status">{notice}</p> : null}
      </div>
    </main>
  );
}
