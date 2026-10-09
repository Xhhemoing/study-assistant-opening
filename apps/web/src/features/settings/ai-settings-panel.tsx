"use client";

import { openingAiSettingsResponseSchema, type OpeningAiSettings, type OpeningAiSettingsResponse, type OpeningModelSummary } from "@aistudy/contracts";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ui } from "../opening/design/ui";
import { availabilityLabels, effectiveModelRoutes, hasRemovedActiveModel, modelOptions, switchRoutingMode, tutorRouteLabels } from "./ai-settings-model";

function ModelSelect({ label, models, supplier, value, fallback, onChange }: {
  label: string; models: OpeningModelSummary[]; supplier: string; value: string | null; fallback: string;
  onChange: (id: string | null) => void;
}) {
  const missing = value !== null && !models.some(model => model.id === value);
  return <label className="block space-y-1.5"><span className={ui.label}>{label}</span>
    <select className={ui.input} value={value ?? ""} onChange={event => onChange(event.target.value || null)}>
      <option value="">{fallback}</option>
      {missing ? <option value={value!}>已移除的模型（{value}）</option> : null}
      {modelOptions(models, supplier, value).map(model => <option key={model.id} value={model.id}>{model.providerLabel} · {model.label}{model.supportsVision ? " · 视觉" : " · 文本"}{model.availability === "available" ? "" : `（${availabilityLabels[model.availability]}）`}</option>)}
    </select>
  </label>;
}

export function AiSettingsForm({ data, draft, busy, onChange, onSave, onReset }: {
  data: OpeningAiSettingsResponse; draft: OpeningAiSettings; busy: boolean;
  onChange: (value: OpeningAiSettings) => void; onSave: () => void; onReset: () => void;
}) {
  const [supplier, setSupplier] = useState("");
  const suppliers = [...new Map(data.models.map(model => [model.providerId, model.providerLabel])).entries()];
  const routes = effectiveModelRoutes(data, draft);
  const selected = [...new Map(routes.flatMap(route => route.model ? [[route.model.id, route.model] as const] : [])).values()];
  const defaultModel = data.models.find(model => model.id === data.defaultModelId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const stale = hasRemovedActiveModel(data, draft);
  return <div className="space-y-4">
    {data.invalidStoredSettings ? <p className="text-sm text-amber-800" role="alert">已保存的设置无效，AI 请求已暂停。请重新选择后保存，或恢复服务器默认设置。</p> : null}
    {!data.models.length ? <p className="text-sm leading-6 text-amber-800">服务器尚未部署可选模型。请联系管理员配置模型目录后重新读取。</p> : null}
    <fieldset disabled={busy} className="space-y-4">
      <legend className="sr-only">模型路由方式</legend>
      <div className="flex flex-wrap gap-4">{[{ value: "manual" as const, label: "手动选择" }, { value: "automatic" as const, label: "按辅导模式自动选择" }].map(option => <label key={option.value} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-zinc-700"><input className="size-4 accent-emerald-700" type="radio" name="ai-routing-mode" checked={draft.mode === option.value} onChange={() => onChange(switchRoutingMode(draft, option.value, data.defaultModelId))} />{option.label}</label>)}</div>
      <section id="daily-budget" data-advanced-section="daily-budget" className="scroll-mt-6 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/90 p-3" aria-labelledby="daily-budget-heading">
        <h3 id="daily-budget-heading" className="text-sm font-medium text-zinc-900">开启并确认每日额度</h3>
        <p className="text-xs leading-6 text-zinc-600">环境上限为 0 时：填写每日额度（分）→ 点「确认开启每日额度」→ 再点下方「保存模型设置」。环境上限 &gt; 0 时可在此调低（不超过运维上限）。</p>
        {data.dailyCapCents === 0 ? <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-6 text-amber-900" role="status">当前有效日额度为 0，AI 辅导不可用。请设置额度并确认后保存。</p> : null}
        <p className="text-xs leading-6 text-zinc-500">有效额度 {data.dailyCapCents} 分。运维环境上限 {data.envCapCents} 分；个人开启时上限 {data.personalCeilingCents} 分。开启前会要求确认「每天最多约 ¥X」。</p>
        <label className="block space-y-1.5"><span className={ui.label}>工作区日额度（分）</span>
          <input className={ui.input} type="number" min={0} max={data.envCapCents > 0 ? data.envCapCents : data.personalCeilingCents} step={1} disabled={busy}
            value={draft.dailyCapCents ?? ""}
            placeholder={data.envCapCents > 0 ? `可调低运维上限（≤${data.envCapCents}）` : "留空表示未设置"}
            onChange={event => {
              const raw = event.target.value;
              if (raw === "") onChange({ ...draft, dailyCapCents: null, budgetConfirmedAt: null });
              else onChange({ ...draft, dailyCapCents: Number(raw) });
            }} />
        </label>
        {data.envCapCents === 0 && (draft.dailyCapCents ?? 0) > 0 && !draft.budgetConfirmedAt ? (
          <button type="button" className={ui.secondary} disabled={busy} onClick={() => {
            const yuan = ((draft.dailyCapCents ?? 0) / 100).toFixed(2);
            if (!window.confirm(`确认开启每日 AI 额度？每天最多约 ¥${yuan}。确认后才会生效。`)) return;
            onChange({ ...draft, budgetConfirmedAt: new Date().toISOString() });
          }}>确认开启每日额度</button>
        ) : null}
        {draft.budgetConfirmedAt ? <p className="text-xs text-emerald-700">已确认于 {draft.budgetConfirmedAt}</p> : null}
      </section>
      <label className="block space-y-1.5"><span className={ui.label}>按供应商筛选可选模型</span><select className={ui.input} value={supplier} onChange={event => setSupplier(event.target.value)}><option value="">全部供应商</option>{suppliers.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      <ModelSelect label={draft.mode === "manual" ? "所有辅导模式使用的模型" : "默认模型"} models={data.models} supplier={supplier} value={draft.mode === "manual" ? draft.manualModelId : draft.defaultModelId} fallback={draft.mode === "manual" ? "请选择明确的模型" : `跟随服务器默认${defaultModel ? `（${defaultModel.label}）` : "（尚未配置）"}`} onChange={id => onChange(draft.mode === "manual" ? { ...draft, manualModelId: id } : { ...draft, defaultModelId: id })} />
      {draft.mode === "automatic" ? <div className="grid gap-3 sm:grid-cols-2">{tutorRouteLabels.map(({ mode, label }) => <ModelSelect key={mode} label={label} models={data.models} supplier={supplier} value={draft.routes[mode]} fallback="使用默认模型" onChange={id => onChange({ ...draft, routes: { ...draft.routes, [mode]: id } })} />)}</div> : null}
    </fieldset>
    <div className="space-y-2 border-t border-zinc-100 pt-3">
      <h3 className="text-xs font-medium text-zinc-800">{dirty || data.invalidStoredSettings ? "保存后使用" : "当前生效规则"}</h3>
      <dl className="space-y-1.5 text-xs leading-6">{(draft.mode === "manual" ? routes.slice(0, 1) : routes).map(route => <div className="flex flex-wrap justify-between gap-x-4" key={route.mode}><dt className="text-zinc-500">{draft.mode === "manual" ? "所有辅导模式" : route.label}</dt><dd className={route.problem ? "text-amber-800" : "text-zinc-800"}>{route.model ? `${route.model.providerLabel} · ${route.model.label}` : "未配置"}{route.problem ? ` · ${route.problem}` : ""}</dd></div>)}</dl>
      {stale ? <p className="text-xs leading-6 text-amber-800" role="alert">{draft.mode === "manual" ? "手动锁定的模型已移除，请在上方重新选择手动模型，或恢复服务器默认设置。" : "自动路由中有模型已移除，请重新选择默认模型或对应规则，或恢复服务器默认设置。"}</p> : null}
      {selected.map(model => <p className="break-words text-xs leading-6 text-zinc-500" key={model.id}>{model.label}（{model.modelName}）：输入 {model.inputCentsPerMillion}、输出 {model.outputCentsPerMillion} 分 / 百万 token。</p>)}
    </div>

    <div className="space-y-1 text-xs leading-6 text-zinc-500"><p>支持文本模型；标记为“视觉”的模型可分析指定 PDF 页图像。价格由服务器或本工作区配置；所有供应商须换算为同一记账币种，不自动换汇。工作区共享日上限当前为 {data.dailyCapCents} 分（按用户本地日，默认 Asia/Shanghai），切换模型不会重置已用额度。</p><p>自动模式只执行以上明确映射，不判断问题难度。任何所选模型不可用时都会停止，不会自动重试或改用其他供应商。保存后供后续选型使用；已开始的请求继续使用原模型。</p><p>服务器目录模型由管理员维护；本工作区自建的供应商与模型可在下方「自定义供应商与密钥」中配置，保存后立即生效，无需重启服务。</p><p>设置中的原生备份暂不包含模型选择、路由与自定义供应商配置，请在迁移服务器前另行记录。</p></div>
    <div className="flex flex-wrap gap-2"><button type="button" className={ui.primary} disabled={busy || stale || routes.some(route => route.problem !== null) || (!dirty && data.saved && !data.invalidStoredSettings)} onClick={onSave}>{busy ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存模型设置</button><button type="button" className={ui.secondary} disabled={busy || (!data.saved && !dirty)} onClick={onReset}>恢复服务器默认设置</button></div>
  </div>;
}

export function AiSettingsPanel() {
  const [data, setData] = useState<OpeningAiSettingsResponse | null>(null);
  const [draft, setDraft] = useState<OpeningAiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const receive = (next: OpeningAiSettingsResponse) => { setData(next); setDraft(next.settings); };
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/opening/ai-settings", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "模型设置暂时无法读取，请重试。");
      if (!signal?.aborted) receive(openingAiSettingsResponseSchema.parse(body));
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "模型设置暂时无法读取，请重试。"); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function save(value: OpeningAiSettings | null) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/opening/ai-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "模型设置保存失败，请重试。");
      receive(openingAiSettingsResponseSchema.parse(body));
      setNotice(value ? "模型设置已保存。后续请求将按以上规则选择模型。" : "已恢复服务器默认设置，请确认下方模型可用状态。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "模型设置保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <section className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="ai-settings-heading">
    <div><h2 id="ai-settings-heading" className="text-sm font-medium text-zinc-900">AI 模型与供应商</h2><p className="mt-1 text-xs leading-6 text-zinc-500">设置助理、资料辅导和临时对话使用的模型。</p></div>
    <div className="min-w-0 space-y-3">
      {error ? <p role="alert" className="text-sm leading-6 text-red-700">{error}</p> : null}
      {busy && !data ? <p className="text-sm text-zinc-500" role="status">正在读取模型设置…</p> : null}
      {data && draft ? <AiSettingsForm data={data} draft={draft} busy={busy} onChange={value => { setDraft(value); setNotice(""); }} onSave={() => void save(draft)} onReset={() => void save(null)} /> : null}
      <button type="button" className={ui.quiet} disabled={busy} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />重新读取模型设置</button>
      {notice ? <p role="status" className="text-sm leading-6 text-emerald-700">{notice}</p> : null}
    </div>
  </section>;
}
