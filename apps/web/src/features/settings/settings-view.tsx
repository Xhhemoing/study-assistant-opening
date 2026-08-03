"use client";

import { Check, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { GuidanceMode } from "../../lib/data/types";
import { useStudyProvider } from "../../lib/data/react";
import { DiagnosticsPanel } from "./diagnostics-panel";

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

export function SettingsView() {
  const router = useRouter();
  const provider = useStudyProvider();
  const [defaultEntry, setDefaultEntry] = useState<WorkspaceEntry | null>(null);
  const [guidanceMode, setGuidanceMode] = useState<GuidanceMode>("balanced");
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
      const body = await preferenceResponse.json() as { defaultEntry?: WorkspaceEntry | null };
      setDefaultEntry(body.defaultEntry ?? null);
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
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-2 border-b border-line pb-6"><p className="text-xs text-text-dim">工作区</p><h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">设置</h1><p className="text-sm leading-6 text-text-dim">调整入口和学习对话的默认方式。</p></header>
      {loading ? <p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在读取设置...</p> : null}
      {error ? <div className="flex flex-wrap items-center gap-3 border-y border-line py-4" role="alert"><p className="text-sm text-danger">{error}</p><button className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-3 text-xs text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => void loadSettings()} type="button"><RefreshCw aria-hidden="true" size={14} />重试</button></div> : null}
      {!loading ? <>
        <section className="space-y-4" aria-labelledby="default-entry-heading"><div><h2 className="text-base font-semibold text-text" id="default-entry-heading">默认入口</h2><p className="mt-1 text-sm text-text-dim">打开工作区首页时进入这里。</p></div><div className="grid gap-2 sm:grid-cols-3">{entries.map((entry) => <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-3 text-sm text-text has-[:checked]:border-primary has-[:checked]:bg-primary/10" key={entry.value}><input checked={defaultEntry === entry.value} className="accent-primary" name="default-entry" onChange={() => setDefaultEntry(entry.value)} type="radio" />{entry.label}</label>)}</div><button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" disabled={!defaultEntry || saving} onClick={() => void saveEntry()} type="button">{saving ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <Save aria-hidden="true" size={16} />}保存入口</button></section>
        <section className="space-y-4 border-t border-line pt-6" aria-labelledby="guidance-heading"><div><h2 className="text-base font-semibold text-text" id="guidance-heading">指导模式</h2><p className="mt-1 text-sm text-text-dim">影响探索中的模拟回复风格。</p></div><select className="min-h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" onChange={(event) => void saveGuidanceMode(event.target.value as GuidanceMode)} value={guidanceMode}>{guidanceModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></section>
        <section className="space-y-3 border-t border-line pt-6" aria-labelledby="demo-heading"><div><h2 className="text-base font-semibold text-text" id="demo-heading">演示数据</h2><p className="mt-1 text-sm text-text-dim">只重置当前账号的本地 mock 学习数据。</p></div><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-danger/40 px-3 text-sm text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-50" disabled={saving} onClick={() => void resetDemoData()} type="button"><Check aria-hidden="true" size={16} />重置演示数据</button></section>
        <DiagnosticsPanel provider={provider} />
      </> : null}
      {notice ? <p className="text-sm text-success" role="status">{notice}</p> : null}
    </main>
  );
}
