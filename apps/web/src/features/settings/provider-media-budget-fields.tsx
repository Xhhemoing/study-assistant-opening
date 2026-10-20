"use client";

import { ui } from "../opening/design/ui";
import type { ProviderModelDraft } from "./provider-settings-model";

type Draft = Pick<ProviderModelDraft, "mediaInputTokenUpperBound" | "mediaMaxInputBytes" | "mediaInputCentsPerMillion">;

/** Shared by quick setup and model editing; no supplier price or token limit is invented. */
export function ProviderMediaBudgetFields({ draft, onChange, disabled = false }: {
  draft: Draft; onChange: (patch: Partial<Draft>) => void; disabled?: boolean;
}) {
  return <details className="rounded-md border border-zinc-200 px-3 py-2">
    <summary className="cursor-pointer text-sm font-medium text-zinc-800">图片与音频费用上界（选填）</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-6 text-zinc-600">请按当前模型供应商的上下文限制与价率填写，系统不会按文件字节猜 token。三项一起填写或全部留空；留空仍可使用文本，图片与音频不会发给这个模型。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5"><span className={ui.label}>媒体输入 token 保守上界</span>
          <input className={ui.input} disabled={disabled} inputMode="numeric" value={draft.mediaInputTokenUpperBound ?? ""} onChange={event => onChange({ mediaInputTokenUpperBound: event.target.value })} /></label>
        <label className="block space-y-1.5"><span className={ui.label}>媒体总大小上限（字节）</span>
          <input className={ui.input} disabled={disabled} inputMode="numeric" value={draft.mediaMaxInputBytes ?? ""} onChange={event => onChange({ mediaMaxInputBytes: event.target.value })} /></label>
        <label className="block space-y-1.5 sm:col-span-2"><span className={ui.label}>含媒体请求的统一输入价格上界（分 / 百万 token）</span>
          <input className={ui.input} disabled={disabled} inputMode="decimal" value={draft.mediaInputCentsPerMillion ?? ""} onChange={event => onChange({ mediaInputCentsPerMillion: event.target.value })} /></label>
      </div>
      <p className="text-xs leading-6 text-zinc-500">token 上界须覆盖上述大小范围内的全部媒体，可按供应商完整上下文上限保守填写。总大小最大为 104857600 字节；单价须同时覆盖请求中的文本和媒体；系统取它与文本输入价的较高值预留。系统保留费用估计来源，实际费用仍需核对供应商账单。更换模型后请重新核对这些值。</p>
    </div>
  </details>;
}
