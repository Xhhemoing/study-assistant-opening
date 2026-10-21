"use client";

import { openingAiSettingsResponseSchema, type OpeningAiSettingsResponse } from "@aistudy/contracts";
import { Check, LoaderCircle, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { ProviderMediaBudgetFields } from "./provider-media-budget-fields";
import { ui } from "../opening/design/ui";
import { availabilityLabels, effectiveTaskRoutes } from "./ai-settings-model";
import { FREE_TIER_NOTICE } from "./provider-settings-model";
import {
  applyQuickSetupPreset, beginQuickSetupSubmission, finishQuickSetupSubmission, initialQuickSetupDraft,
  initialQuickSetupSubmission, isDefiniteQuickSetupRejection, validateQuickSetupDraft,
  type QuickSetupDraft, type QuickSetupPreset,
} from "./quick-setup-model";

export function QuickSetupForm({ draft, preset, busy, locked = false, advanced = false, onChange, onPreset, onSubmit }: {
  draft: QuickSetupDraft; preset: QuickSetupPreset; busy: boolean; locked?: boolean; advanced?: boolean;
  onChange: (draft: QuickSetupDraft) => void; onPreset: (preset: QuickSetupPreset) => void; onSubmit: () => void;
}) {
  const problem = validateQuickSetupDraft(draft);
  const free = draft.billing === "free_tier";
  const pricingFields = <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block space-y-1.5"><span className={ui.label}>输入价格（分 / 百万 token）</span>
        <input className={ui.input} inputMode="decimal" value={draft.inputCentsPerMillion} placeholder={free ? "免费额度可留空，按 0 记账" : "以供应商公布价格为准"} onChange={event => onChange({ ...draft, inputCentsPerMillion: event.target.value })} /></label>
      <label className="block space-y-1.5"><span className={ui.label}>输出价格（分 / 百万 token）</span>
        <input className={ui.input} inputMode="decimal" value={draft.outputCentsPerMillion} placeholder={free ? "免费额度可留空，按 0 记账" : "以供应商公布价格为准"} onChange={event => onChange({ ...draft, outputCentsPerMillion: event.target.value })} /></label>
    </div>
    <ProviderMediaBudgetFields draft={draft} onChange={patch => onChange({ ...draft, ...patch })} />
    <p className="text-xs leading-6 text-text-3">价格请使用统一记账币种；不自动换汇。</p>
  </div>;
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
      {advanced ? pricingFields : <details className="rounded-md border border-line px-3 py-2" data-quick-setup-advanced="true">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">高级模型选项</summary>
        <div className="mt-3">{pricingFields}</div>
      </details>}
      {!advanced && !free ? <p className="text-xs leading-6 text-text-2">按量计费需在「高级模型选项」中填写供应商价格。</p> : null}
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
    <p className="text-xs leading-6 text-text-3">保存后，各项 AI 功能默认使用这个模型。</p>
    {locked ? <p className="text-xs leading-6 text-warn" role="status">上次配置结果尚未确认，表单已锁定。确认会使用上次原始配置和请求标识，不会创建第二份配置。</p> : problem ? <p className="text-xs leading-6 text-warn" role="status">{problem}</p> : null}
    <button className={ui.primary} disabled={busy || (!locked && problem !== null)} type="submit">
      {busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <WandSparkles aria-hidden="true" size={14} />}{locked ? "确认上次配置结果" : "一键配置模型"}
    </button>
  </form>;
}

export function QuickSetupResult({ data, basePath = "/settings", advanced = false }: { data: OpeningAiSettingsResponse; basePath?: string; advanced?: boolean }) {
  const routes = effectiveTaskRoutes(data, data.settings);
  const model = data.models.find(item => item.id === (data.settings.defaultModelId ?? data.defaultModelId));
  const problem = !model ? "默认模型尚未配置，请到高级设置检查。"
    : model.availability !== "available" ? availabilityLabels[model.availability]
      : routes.some(route => route.problem) ? "部分功能还需补充配置，请到高级设置查看。" : null;
  return <div className="space-y-2 rounded-lg border border-accent/30 bg-accent-soft p-3">
    <p className="flex items-center gap-2 text-sm text-accent" role="status"><Check aria-hidden="true" size={15} />配置已保存，密钥输入已清空。</p>
    {advanced ? <><p className="text-xs leading-6 text-text-2">下方显示配置是否满足各用途要求；实际连通性请在高级设置的模型列表中测试。</p>
    <dl className="space-y-1 text-xs leading-6">{routes.map(route => <div className="flex flex-wrap justify-between gap-x-4" key={route.task.key}>
      <dt className="text-text-2">{route.task.label}</dt><dd className={route.problem ? "text-warn" : "text-accent"}>{route.problem ?? "配置可用"}</dd>
    </div>)}</dl></> : <>
      <p className="text-sm text-text">默认模型：{model ? `${model.label}（${model.modelName}）` : "尚未配置"}</p>
      <p className={`text-xs leading-6 ${problem ? "text-warn" : "text-text-2"}`}>{problem ?? "配置已就绪，可在高级设置测试连接。"}</p>
    </>}
    <Link className={ui.quiet} href={`${basePath}/advanced`}>{advanced ? "查看模型路由与连通性测试" : "打开高级设置"}</Link>
  </div>;
}

export function QuickSetupPanel({ onConfigured, basePath = "/settings", advanced = false }: { onConfigured?: (data: OpeningAiSettingsResponse) => void; basePath?: string; advanced?: boolean }) {
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
    <div><h2 id="quick-model-setup-heading" className="text-sm font-medium text-text">一键配置 AI 模型</h2><p className="mt-1 text-xs leading-6 text-text-3">填写一次，用同一个模型辅导、主讲和处理材料。</p></div>
    <div className="min-w-0 space-y-3">
      <QuickSetupForm draft={draft} preset={preset} busy={busy} locked={submission.uncertain} advanced={advanced} onChange={value => { setDraft(value); setError(""); }} onPreset={value => { setPreset(value); setDraft(current => applyQuickSetupPreset(current, value)); setError(""); }} onSubmit={() => void submit()} />
      {error ? <p className="text-sm leading-6 text-danger" role="alert">{error}</p> : null}
      {result ? <QuickSetupResult data={result} basePath={basePath} advanced={advanced} /> : null}
    </div>
  </section>;
}
