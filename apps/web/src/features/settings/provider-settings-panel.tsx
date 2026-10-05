"use client";

import {
  openingProviderConfigResponseSchema,
  type OpeningProviderConfigResponse, type OpeningProviderModelView, type OpeningProviderView,
} from "@aistudy/contracts";
import { KeyRound, LoaderCircle, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ui } from "../opening/design/ui";
import {
  emptyModelDraft, emptyProviderDraft, keyStatusText, modelDraftFromView, modelRequestBody,
  providerDraftFromView, providerRequestBody, validateModelDraft, validateProviderDraft,
  type ProviderDraft, type ProviderModelDraft,
} from "./provider-settings-model";

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : "服务商配置暂时不可用，请重试。";
    throw new Error(message);
  }
  return body as T;
}

function ProviderForm({ draft, busy, onChange, onSubmit, submitLabel, onCancel }: {
  draft: ProviderDraft; busy: boolean; submitLabel: string;
  onChange: (draft: ProviderDraft) => void; onSubmit: () => void; onCancel?: () => void;
}) {
  const problem = validateProviderDraft(draft);
  const dirty = draft.apiKey.length > 0 || draft.label.trim() !== draft.label || draft.baseUrl.trim() !== draft.baseUrl;
  return <div className="space-y-2 rounded-md border border-zinc-200 p-3">
    <label className="block space-y-1.5"><span className={ui.label}>服务商名称</span>
      <input className={ui.input} disabled={busy} maxLength={120} onChange={event => onChange({ ...draft, label: event.target.value })} placeholder="例如：DeepSeek" value={draft.label} /></label>
    <label className="block space-y-1.5"><span className={ui.label}>接口地址（OpenAI 兼容 baseUrl）</span>
      <input className={ui.input} disabled={busy} onChange={event => onChange({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" value={draft.baseUrl} /></label>
    <label className="block space-y-1.5"><span className={ui.label}>API 密钥{draft.apiKey ? "" : "（留空表示不修改密钥）"}</span>
      <input autoComplete="new-password" className={ui.input} disabled={busy} maxLength={4096} onChange={event => onChange({ ...draft, apiKey: event.target.value })} type="password" value={draft.apiKey} /></label>
    {problem ? <p className="text-xs leading-6 text-amber-800" role="alert">{problem}</p> : null}
    <div className="flex flex-wrap gap-2">
      <button className={ui.primary} disabled={busy || problem !== null || !dirty} onClick={onSubmit} type="button">
        {busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}{submitLabel}</button>
      {onCancel ? <button className={ui.secondary} disabled={busy} onClick={onCancel} type="button">取消</button> : null}
    </div>
  </div>;
}

function ModelForm({ draft, busy, onChange, onSubmit, submitLabel, onCancel }: {
  draft: ProviderModelDraft; busy: boolean; submitLabel: string;
  onChange: (draft: ProviderModelDraft) => void; onSubmit: () => void; onCancel?: () => void;
}) {
  const problem = validateModelDraft(draft);
  return <div className="space-y-2 rounded-md border border-zinc-200 p-3">
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block space-y-1.5"><span className={ui.label}>模型显示名</span>
        <input className={ui.input} disabled={busy} maxLength={120} onChange={event => onChange({ ...draft, label: event.target.value })} value={draft.label} /></label>
      <label className="block space-y-1.5"><span className={ui.label}>模型名称（请求参数）</span>
        <input className={ui.input} disabled={busy} maxLength={200} onChange={event => onChange({ ...draft, modelName: event.target.value })} value={draft.modelName} /></label>
      <label className="block space-y-1.5"><span className={ui.label}>输入价格（分 / 百万 token）</span>
        <input className={ui.input} disabled={busy} inputMode="decimal" onChange={event => onChange({ ...draft, inputCentsPerMillion: event.target.value })} value={draft.inputCentsPerMillion} /></label>
      <label className="block space-y-1.5"><span className={ui.label}>输出价格（分 / 百万 token）</span>
        <input className={ui.input} disabled={busy} inputMode="decimal" onChange={event => onChange({ ...draft, outputCentsPerMillion: event.target.value })} value={draft.outputCentsPerMillion} /></label>
    </div>
    <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-zinc-700">
      <span>支持视觉（可分析 PDF 页图像）</span>
      <input checked={draft.supportsVision} className="size-4 accent-emerald-700" disabled={busy} onChange={event => onChange({ ...draft, supportsVision: event.target.checked })} type="checkbox" />
    </label>
    {problem ? <p className="text-xs leading-6 text-amber-800" role="alert">{problem}</p> : null}
    <div className="flex flex-wrap gap-2">
      <button className={ui.primary} disabled={busy || problem !== null} onClick={onSubmit} type="button">
        {busy ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}{submitLabel}</button>
      {onCancel ? <button className={ui.secondary} disabled={busy} onClick={onCancel} type="button">取消</button> : null}
    </div>
  </div>;
}

export function ProviderSettingsForm({ data, busy, onCreateProvider, onUpdateProvider, onDeleteProvider, onCreateModel, onUpdateModel, onDeleteModel }: {
  data: OpeningProviderConfigResponse; busy: boolean;
  onCreateProvider: (draft: ProviderDraft) => void;
  onUpdateProvider: (id: string, draft: ProviderDraft) => void;
  onDeleteProvider: (view: OpeningProviderView) => void;
  onCreateModel: (providerId: string, draft: ProviderModelDraft) => void;
  onUpdateModel: (model: OpeningProviderModelView, draft: ProviderModelDraft) => void;
  onDeleteModel: (model: OpeningProviderModelView) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newProvider, setNewProvider] = useState<ProviderDraft>(emptyProviderDraft);
  const [editing, setEditing] = useState<Record<string, ProviderDraft>>({});
  const [addingModelFor, setAddingModelFor] = useState<string | null>(null);
  const [newModel, setNewModel] = useState<ProviderModelDraft>(emptyModelDraft);
  const [editingModels, setEditingModels] = useState<Record<string, ProviderModelDraft>>({});
  return <div className="space-y-4">
    <p className="text-xs leading-6 text-zinc-500">这里配置本工作区自己的模型供应商与密钥：密钥加密保存在服务器、永不下发浏览器，配置后可在上方「模型路由」选择这些模型。价格按分 / 百万 token 记账，与服务器目录使用同一预算上限。</p>
    {data.providers.length === 0 && !creating ? <p className="text-sm leading-6 text-zinc-500">尚未添加自定义供应商。服务器目录中的模型不受影响。</p> : null}
    <ul className="space-y-3">{data.providers.map(provider => {
      const models = data.models.filter(model => model.providerId === provider.id);
      const edit = editing[provider.id];
      return <li className="rounded-md border border-zinc-100 p-3" key={provider.id}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900">{provider.label}</p>
            <p className="truncate text-xs leading-6 text-zinc-500">{provider.baseUrl}</p>
            <p className="text-xs leading-6 text-zinc-500"><KeyRound aria-hidden="true" className="inline" size={12} /> {keyStatusText(provider)} · {models.length} 个模型</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={ui.quiet} disabled={busy} onClick={() => setAddingModelFor(addingModelFor === provider.id ? null : provider.id)} type="button"><Plus aria-hidden="true" size={14} />添加模型</button>
            <button className={ui.quiet} disabled={busy} onClick={() => setEditing(current => {
              const next = { ...current };
              if (next[provider.id]) delete next[provider.id]; else next[provider.id] = providerDraftFromView(provider);
              return next;
            })} type="button">编辑</button>
            <button className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-red-200 px-2 text-xs text-red-700 hover:bg-red-50" disabled={busy} onClick={() => onDeleteProvider(provider)} type="button"><Trash2 aria-hidden="true" size={14} />删除</button>
          </div>
        </div>
        {edit ? <div className="mt-3"><ProviderForm draft={edit} busy={busy} onCancel={() => setEditing(current => { const next = { ...current }; delete next[provider.id]; return next; })} onChange={value => setEditing({ ...editing, [provider.id]: value })} onSubmit={() => onUpdateProvider(provider.id, edit)} submitLabel="保存服务商" /></div> : null}
        {addingModelFor === provider.id ? <div className="mt-3"><ModelForm draft={newModel} busy={busy} onCancel={() => { setAddingModelFor(null); setNewModel(emptyModelDraft); }} onChange={setNewModel} onSubmit={() => onCreateModel(provider.id, newModel)} submitLabel="添加模型" /></div> : null}
        {models.length ? <ul className="mt-3 space-y-2">{models.map(model => {
          const modelEdit = editingModels[model.id];
          return <li className="rounded-md bg-zinc-50 p-2" key={model.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-xs leading-6 text-zinc-700">
                <p className="font-medium text-zinc-900">{model.label} · {model.modelName}{model.supportsVision ? " · 视觉" : ""}</p>
                <p>输入 {model.inputCentsPerMillion}、输出 {model.outputCentsPerMillion} 分 / 百万 token</p>
              </div>
              <div className="flex gap-2">
                <button className={ui.quiet} disabled={busy} onClick={() => setEditingModels(current => {
                  const next = { ...current };
                  if (next[model.id]) delete next[model.id]; else next[model.id] = modelDraftFromView(model);
                  return next;
                })} type="button">编辑</button>
                <button className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-red-200 px-2 text-xs text-red-700 hover:bg-red-50" disabled={busy} onClick={() => onDeleteModel(model)} type="button"><Trash2 aria-hidden="true" size={14} />删除</button>
              </div>
            </div>
            {modelEdit ? <div className="mt-2"><ModelForm draft={modelEdit} busy={busy} onCancel={() => setEditingModels(current => { const next = { ...current }; delete next[model.id]; return next; })} onChange={value => setEditingModels({ ...editingModels, [model.id]: value })} onSubmit={() => onUpdateModel(model, modelEdit)} submitLabel="保存模型" /></div> : null}
          </li>;
        })}</ul> : null}
      </li>;
    })}</ul>
    {creating ? <ProviderForm draft={newProvider} busy={busy} onCancel={() => { setCreating(false); setNewProvider(emptyProviderDraft); }} onChange={setNewProvider} onSubmit={() => onCreateProvider(newProvider)} submitLabel="添加服务商" /> : <button className={ui.secondary} disabled={busy} onClick={() => { setCreating(true); setNewProvider(emptyProviderDraft); }} type="button"><Plus aria-hidden="true" size={14} />添加服务商</button>}
  </div>;
}

export function ProviderSettingsPanel() {
  const [data, setData] = useState<OpeningProviderConfigResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const parsed = openingProviderConfigResponseSchema.parse(await requestJson("/api/opening/model-providers", { signal }));
      if (!signal?.aborted) { setData(parsed); setNotice(""); }
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "服务商配置暂时无法读取，请重试。"); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await action()); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试。"); }
    finally { setBusy(false); }
  }
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return <section aria-labelledby="provider-settings-heading" className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
    <div><h2 className="text-sm font-medium text-zinc-900" id="provider-settings-heading">自定义供应商与密钥</h2><p className="mt-1 text-xs leading-6 text-zinc-500">管理工作区自己的模型供应商。</p></div>
    <div className="min-w-0 space-y-3">
      {error ? <p className="text-sm leading-6 text-red-700" role="alert">{error}</p> : null}
      {busy && !data ? <p className="text-sm text-zinc-500" role="status">正在读取服务商配置…</p> : null}
      {data ? <ProviderSettingsForm
        busy={busy}
        data={data}
        onCreateProvider={draft => void run(async () => {
          await requestJson("/api/opening/model-providers", jsonInit("POST", providerRequestBody(draft)));
          return "服务商已添加。请确认密钥与接口地址后添加模型。";
        })}
        onUpdateProvider={(id, draft) => void run(async () => {
          await requestJson(`/api/opening/model-providers/${id}`, jsonInit("PUT", providerRequestBody(draft)));
          return "服务商已保存。";
        })}
        onDeleteProvider={view => {
          if (!window.confirm(`删除服务商「${view.label}」将同时删除其全部模型，已选用的模型会恢复为服务器默认。确定删除吗？`)) return;
          void run(async () => {
            await requestJson(`/api/opening/model-providers/${view.id}`, { method: "DELETE" });
            return "服务商已删除。";
          });
        }}
        onCreateModel={(providerId, draft) => void run(async () => {
          await requestJson(`/api/opening/model-providers/${providerId}/models`, jsonInit("POST", modelRequestBody(draft)));
          return "模型已添加，可在上方「模型路由」中选择。";
        })}
        onUpdateModel={(model, draft) => void run(async () => {
          await requestJson(`/api/opening/model-providers/${model.providerId}/models/${model.id}`, jsonInit("PUT", modelRequestBody(draft)));
          return "模型已保存。";
        })}
        onDeleteModel={model => {
          if (!window.confirm(`删除模型「${model.label}」后，使用它的路由将恢复默认。确定删除吗？`)) return;
          void run(async () => {
            await requestJson(`/api/opening/model-providers/${model.providerId}/models/${model.id}`, { method: "DELETE" });
            return "模型已删除。";
          });
        }}
      /> : null}
      <button className={ui.quiet} disabled={busy} onClick={() => void load()} type="button"><RefreshCw aria-hidden="true" size={14} />重新读取服务商配置</button>
      {notice ? <p className="text-sm leading-6 text-emerald-700" role="status">{notice}</p> : null}
    </div>
  </section>;
}
