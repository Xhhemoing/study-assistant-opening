"use client";

import { openingAiSettingsResponseSchema, type OpeningAiSettingsResponse } from "@aistudy/contracts";
import { Check, LoaderCircle, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { ProviderMediaBudgetFields } from "./provider-media-budget-fields";
import { ui } from "../opening/design/ui";
import { effectiveTaskRoutes } from "./ai-settings-model";
import { FREE_TIER_NOTICE } from "./provider-settings-model";
import {
  applyQuickSetupPreset, beginQuickSetupSubmission, finishQuickSetupSubmission, initialQuickSetupDraft,
  initialQuickSetupSubmission, isDefiniteQuickSetupRejection, validateQuickSetupDraft,
  type QuickSetupDraft, type QuickSetupPreset,
} from "./quick-setup-model";

export function QuickSetupForm({ draft, preset, busy, locked = false, onChange, onPreset, onSubmit }: {
  draft: QuickSetupDraft; preset: QuickSetupPreset; busy: boolean; locked?: boolean;
  onChange: (draft: QuickSetupDraft) => void; onPreset: (preset: QuickSetupPreset) => void; onSubmit: () => void;
}) {
  const problem = validateQuickSetupDraft(draft);
  const free = draft.billing === "free_tier";
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if ((locked || !problem) && !busy) onSubmit(); }}>
    <fieldset className="space-y-3" disabled={busy || locked}>
      <legend className="sr-only">一键配置模型</legend>
      <label className="block space-y-1.5"><span className={ui.label}>供应商预设</span>
        <select className={ui.input} value={preset} onChange={event => onPreset(event.target.value as QuickSetupPreset)}>
          <option value="gemini_free">Google Gemini（免费额度）</option><option value="openai_compatible">其他 OpenAI 兼容接口</option>
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5"><span className={ui.label}>配置名称</span>
          <input className={ui.input} maxLength={120} value={draft.label} placeholder="例如：我的 Gemini" onChange={event => onChange({ ...draft, label: event.target.value })} /></label>
        <label className="block space-y-1.5"><span className={ui.label}>模型名称</span>
          <input className={ui.input} maxLength={200} value={draft.modelName} placeholder="以供应商文档为准" onChange={event => onChange({ ...draft, modelName: event.target.value })} /></label>
      </div>
      <label className="block space-y-1.5"><span className={ui.label}>接口地址（OpenAI 兼容 baseUrl）</span>
        <input className={ui.input} maxLength={2048} type="url" value={draft.baseUrl} onChange={event => onChange({ ...draft, baseUrl: event.target.value })} /></label>
      <label className="block space-y-1.5"><span className={ui.label}>API 密钥</span>
        <input autoComplete="new-password" className={ui.input} maxLength={4096} type="password" value={draft.apiKey} onChange={event => onChange({ ...draft, apiKey: event.target.value })} />
        <span className="block text-xs leading-6 text-text-3">只写入并加密保存；成功后清空此输入，不保存到浏览器存储。</span></label>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text-2"><input className="size-4 accent-accent" type="checkbox" checked={draft.supportsVision} onChange={event => onChange({ ...draft, supportsVision: event.target.checked })} />支持视觉</label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text-2"><input className="size-4 accent-accent" type="checkbox" checked={draft.supportsAudio} onChange={event => onChange({ ...draft, supportsAudio: event.target.checked })} />支持音频输入</label>
      </div>
      <label className="block space-y-1.5"><span className={ui.label}>计费方式</span>
        <select className={ui.input} value={draft.billing} onChange={event => onChange({ ...draft, billing: event.target.value as QuickSetupDraft["billing"], confirmBudget: false })}>
          <option value="free_tier">免费额度（限制每日请求数）</option><option value="metered">按量计费（限制每日金额）</option>
        </select></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5"><span className={ui.label}>输入价格（分 / 百万 token）</span>
          <input className={ui.input} inputMode="decimal" value={draft.inputCentsPerMillion} placeholder={free ? "免费额度可留空，按 0 记账" : "以供应商公布价格为准"} onChange={event => onChange({ ...draft, inputCentsPerMillion: event.target.value })} /></label>
        <label className="block space-y-1.5"><span className={ui.label}>输出价格（分 / 百万 token）</span>
          <input className={ui.input} inputMode="decimal" value={draft.outputCentsPerMillion} placeholder={free ? "免费额度可留空，按 0 记账" : "以供应商公布价格为准"} onChange={event => onChange({ ...draft, outputCentsPerMillion: event.target.value })} /></label>
      </div>
      <ProviderMediaBudgetFields draft={draft} onChange={patch => onChange({ ...draft, ...patch })} />
      {free ? <>
        <label className="block space-y-1.5"><span className={ui.label}>每日请求上限</span>
          <input className={ui.input} inputMode="numeric" value={draft.dailyRequestCap} onChange={event => onChange({ ...draft, dailyRequestCap: event.target.value })} /></label>
        <p className="text-xs leading-6 text-warn" role="note">{FREE_TIER_NOTICE}</p>
        <p className="text-xs leading-6 text-text-3">200 次为初始限制，请按供应商当前免费额度调整；请求成功与可用额度以供应商为准。</p>
      </> : <>
        <label className="block space-y-1.5"><span className={ui.label}>每日额度（分）</span>
          <input className={ui.input} inputMode="numeric" value={draft.dailyCapCents} onChange={event => onChange({ ...draft, dailyCapCents: event.target.value, confirmBudget: false })} /></label>
        <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm leading-6 text-text-2">
          <input className="mt-1 size-4 shrink-0 accent-accent" type="checkbox" checked={draft.confirmBudget} onChange={event => onChange({ ...draft, confirmBudget: event.target.checked })} />
          我确认开启每日额度{Number.isSafeInteger(Number(draft.dailyCapCents)) && Number(draft.dailyCapCents) > 0 ? `，每天最多约 ¥${(Number(draft.dailyCapCents) / 100).toFixed(2)}` : ""}。</label>
      </>}
    </fieldset>
    <p className="text-xs leading-6 text-text-3">保存会将此模型设为默认，并清空已有的辅导模式及用途专属路由。价格请使用统一记账币种；不自动换汇。</p>
    {locked ? <p className="text-xs leading-6 text-warn" role="status">上次配置结果尚未确认，表单已锁定。确认会使用上次原始配置和请求标识，不会创建第二份配置。</p> : problem ? <p className="text-xs leading-6 text-warn" role="status">{problem}</p> : null}
    <button className={ui.primary} disabled={busy || (!locked && problem !== null)} type="submit">
      {busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <WandSparkles aria-hidden="true" size={14} />}{locked ? "确认上次配置结果" : "一键配置模型"}
    </button>
  </form>;
}

export function QuickSetupResult({ data, basePath = "/settings" }: { data: OpeningAiSettingsResponse; basePath?: string }) {
  const routes = effectiveTaskRoutes(data, data.settings);
  return <div className="space-y-2 rounded-lg border border-accent/30 bg-accent-soft p-3">
    <p className="flex items-center gap-2 text-sm text-accent" role="status"><Check aria-hidden="true" size={15} />配置已保存，密钥输入已清空。</p>
    <p className="text-xs leading-6 text-text-2">下方显示配置是否满足各用途要求；实际连通性请在高级设置的模型列表中测试。</p>
    <dl className="space-y-1 text-xs leading-6">{routes.map(route => <div className="flex flex-wrap justify-between gap-x-4" key={route.task.key}>
      <dt className="text-text-2">{route.task.label}</dt><dd className={route.problem ? "text-warn" : "text-accent"}>{route.problem ?? "配置可用"}</dd>
    </div>)}</dl>
    <Link className={ui.quiet} href={`${basePath}/advanced`}>查看模型路由与连通性测试</Link>
  </div>;
}

export function QuickSetupPanel({ onConfigured, basePath = "/settings" }: { onConfigured?: (data: OpeningAiSettingsResponse) => void; basePath?: string }) {
  const [draft, setDraft] = useState(initialQuickSetupDraft);
  const [preset, setPreset] = useState<QuickSetupPreset>("gemini_free");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OpeningAiSettingsResponse | null>(null);
  const [submission, setSubmission] = useState(initialQuickSetupSubmission);
  const submitting = useRef(false);
  async function submit() {
    if (submitting.current || (!submission.payload && validateQuickSetupDraft(draft))) return;
    submitting.current = true;
    const attempt = beginQuickSetupSubmission(submission, draft, submission.clientKey ?? crypto.randomUUID());
    setSubmission(attempt);
    setBusy(true); setError("");
    let configured: OpeningAiSettingsResponse | null = null;
    try {
      const response = await fetch("/api/opening/model-providers/quick-setup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(attempt.payload),
      });
      if (!response.ok) {
        const rejected = isDefiniteQuickSetupRejection(response.status);
        setSubmission(finishQuickSetupSubmission(attempt, rejected ? "rejected" : "unknown"));
        setError(rejected ? "一键配置未保存，请检查名称、价格、每日额度和密钥配置后重试。" : "暂时无法确认配置结果，请确认上次配置结果。");
        return;
      }
      const body: unknown = await response.json();
      const data = openingAiSettingsResponseSchema.parse(body);
      setResult(data); setDraft(current => ({ ...current, apiKey: "" }));
      setSubmission(finishQuickSetupSubmission(attempt, "success"));
      configured = data;
    } catch {
      setSubmission(finishQuickSetupSubmission(attempt, "unknown"));
      setError("暂时无法确认配置结果，请确认上次配置结果；原始配置和请求标识会保留，避免重复创建。");
    }
    finally { submitting.current = false; setBusy(false); }
    if (configured) onConfigured?.(configured);
  }
  return <section id="quick-model-setup" className="scroll-mt-6 grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="quick-model-setup-heading">
    <div><h2 id="quick-model-setup-heading" className="text-sm font-medium text-text">一键配置 AI 模型</h2><p className="mt-1 text-xs leading-6 text-text-3">填写一次，将一个模型用于辅导、主讲及材料处理。各用途的输入能力要求会在保存后列出。</p></div>
    <div className="min-w-0 space-y-3">
      <QuickSetupForm draft={draft} preset={preset} busy={busy} locked={submission.uncertain} onChange={value => { setDraft(value); setError(""); }} onPreset={value => { setPreset(value); setDraft(current => applyQuickSetupPreset(current, value)); setError(""); }} onSubmit={() => void submit()} />
      {error ? <p className="text-sm leading-6 text-danger" role="alert">{error}</p> : null}
      {result ? <QuickSetupResult data={result} basePath={basePath} /> : null}
    </div>
  </section>;
}
