"use client";

import { useId, useState } from "react";
import type { MaterialImportBindingInput } from "@aistudy/contracts";
import { buildMappingDraft, emptyMappingDraftFields, mappingDraftMetadataSchema,
  type MappingDraftFields, type MappingDraftMetadata } from "./material-mapping-draft-model";

export interface MaterialMappingDraftProps {
  /** Owner-authorized metadata via DI only; this component grants no access. */
  input: unknown;
  /** Private author draft only, never persistence, publication or first-answer data. */
  onDraft: (draft: MaterialImportBindingInput) => void;
}

export function MaterialMappingDraft({ input, onDraft }: MaterialMappingDraftProps) {
  const parsed = mappingDraftMetadataSchema.safeParse(input);
  if (!parsed.success) return <p role="alert">资料信息不完整或不可用，无法编辑。请联系资料负责人。</p>;
  // Every binding/actor/reset/locator change synchronously destroys the old local state.
  // Canonical parsed data only: never stringify or display invalid private input/errors.
  return <DraftEditor key={JSON.stringify(parsed.data)} metadata={parsed.data} onDraft={onDraft} />;
}

function DraftEditor({ metadata, onDraft }: { metadata: MappingDraftMetadata; onDraft: MaterialMappingDraftProps["onDraft"] }) {
  const prefix = useId();
  const [fields, setFields] = useState(emptyMappingDraftFields);
  const [status, setStatus] = useState("");
  const [handedOff, setHandedOff] = useState(false);
  const draft = buildMappingDraft(metadata, fields);
  function change(patch: Partial<MappingDraftFields>) {
    setFields(previous => ({ ...previous, ...patch, confirmed: false }));
    setStatus(""); setHandedOff(false);
  }
  function clear(message: string) {
    setFields(emptyMappingDraftFields()); setHandedOff(false); setStatus(message);
  }
  const inputClass = "w-full rounded border border-slate-300 bg-white p-2 text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600";
  function textInput(label: string, name: "stem" | "answer" | "unit") {
    const id = `${prefix}-${name}`;
    return <div className="space-y-1"><label htmlFor={id}>{label}</label>
      {name === "unit" ? <input id={id} className={inputClass} maxLength={40} value={fields[name]} onChange={event => change({ [name]: event.target.value })} />
        : <textarea id={id} className={inputClass} maxLength={8000} value={fields[name]} onChange={event => change({ [name]: event.target.value })} />}</div>;
  }
  function location(part: "question" | "answer", label: string) {
    const chunk = metadata.chunks.find(item => item.chunkId === fields[`${part}Chunk`]);
    return <fieldset className="space-y-2 rounded border border-slate-300 p-3"><legend>{label}来源定位</legend>
      <label className="block" htmlFor={`${prefix}-${part}-chunk`}>{label}来源片段</label>
      <select id={`${prefix}-${part}-chunk`} className={inputClass} value={fields[`${part}Chunk`]} onChange={event => {
        // Rebinding either side discards BOTH transcriptions and confirmation.
        setFields(previous => ({ ...emptyMappingDraftFields(), questionChunk: previous.questionChunk, answerChunk: previous.answerChunk, [`${part}Chunk`]: event.target.value }));
        setStatus(""); setHandedOff(false);
      }}>
        <option value="">请人工选择片段</option>
        {metadata.chunks.map(item => <option key={item.chunkId} value={item.chunkId}>{item.chunkId} · 物理页 {item.physicalPage ?? "未知"} · 印刷标记 {item.printedLabel ?? "未知"}</option>)}
      </select>
      {chunk && <p>物理页：{chunk.physicalPage ?? "未知（文本片段或未提供）"}；印刷标记：{chunk.printedLabel ?? "未知"}。两者不互相替代。</p>}
      {(["Start", "End"] as const).map(bound => {
        const name = `${part}${bound}` as const;
        const id = `${prefix}-${name}`;
        return <div key={name}><label htmlFor={id}>{label}{bound === "Start" ? "起点" : "终点"}（UTF-16，{bound === "Start" ? "含" : "不含"}）</label>
          <input id={id} className={inputClass} inputMode="numeric" value={fields[name]} onChange={event => {
            setFields(previous => ({ ...emptyMappingDraftFields(), questionChunk: previous.questionChunk, answerChunk: previous.answerChunk,
              questionStart: previous.questionStart, questionEnd: previous.questionEnd, answerStart: previous.answerStart, answerEnd: previous.answerEnd,
              [name]: event.target.value }));
            setStatus(""); setHandedOff(false);
          }} /></div>;
      })}
      <p className="text-sm">按原片段文本填写范围；不从题号、印刷标记猜测页码。{chunk ? `片段长度：${chunk.textLength}。` : "尚未选择来源片段。"}</p>
    </fieldset>;
  }
  return <section aria-label="人工映射本地草稿" className="space-y-4 rounded border border-slate-300 p-4 text-slate-950">
    <h2 className="text-lg font-semibold">资料作者 · 人工映射草稿</h2>
    <p>仅限获准的资料作者。资料信息由负责人提供，本组件不认证身份或授予访问权限。</p>
    <p>仅编辑本地草稿，不自动保存或发布；不作为独立作答或掌握证据，不用于学生首答。</p>
    <dl className="space-y-1 break-all text-sm"><dt>来源 ID</dt><dd>{metadata.sourceId}</dd>
      <dt>来源版本</dt><dd>{metadata.sourceVersion}</dd><dt>来源 SHA-256</dt><dd>{metadata.sourceSha256}</dd></dl>
    <p>题目与答案必须来自以上同一来源、版本和 SHA；题目与答案分别人工定位、转录。修改任一定位会清空旧题文和答案。</p>
    <div className="grid gap-3 md:grid-cols-2">{location("question", "题目")}{location("answer", "答案")}</div>
    {textInput("题目正文（人工转录）", "stem")}
    <label className="block" htmlFor={`${prefix}-kind`}>作答方式</label>
    <select id={`${prefix}-kind`} className={inputClass} value={fields.kind} onChange={event => change({ kind: event.target.value as MappingDraftFields["kind"] })}>
      <option value="numeric">数值题</option><option value="choice">选择题</option>
    </select>
    {fields.kind === "numeric" ? textInput("单位（可不填）", "unit") : <fieldset className="space-y-2"><legend>人工填写选项（2 至 6 项）</legend>
      {fields.options.map((option, index) => <div key={index} className="grid gap-2 sm:grid-cols-2">
        {(["id", "label"] as const).map(name => <label key={name}>选项 {index + 1} {name === "id" ? "编号" : "正文"}
          <input className={inputClass} value={option[name]} maxLength={name === "id" ? 20 : 500} onChange={event => change({ options: fields.options.map((item, i) => i === index ? { ...item, [name]: event.target.value } : item) })} /></label>)}
      </div>)}
      <button type="button" disabled={fields.options.length >= 6} onClick={() => change({ options: [...fields.options, { id: "", label: "" }] })}>添加选项</button>
      <button type="button" disabled={fields.options.length <= 2} onClick={() => change({ options: fields.options.slice(0, -1) })}>移除末项</button>
    </fieldset>}
    {textInput("答案正文（人工转录）", "answer")}
    <label className="flex items-start gap-2"><input type="checkbox" checked={fields.confirmed} onChange={event => { setFields(previous => ({ ...previous, confirmed: event.target.checked })); setHandedOff(false); setStatus(""); }} />
      我已人工核对题文、答案及各自源定位，确认交出本地草稿；这不是保存、发布或最终样例批准。</label>
    {!draft && <p>请完整填写合法题文、答案与来源范围，并人工确认。未知定位不可猜测。</p>}
    <div className="flex flex-wrap gap-3">
      <button className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={!draft || handedOff} onClick={() => {
        if (!draft || handedOff) return;
        onDraft(draft); setHandedOff(true); setStatus("草稿已交给调用方；尚未保存或发布。");
      }}>交出本地草稿</button>
      <button type="button" onClick={() => clear("已取消并清空本地草稿。")}>取消草稿</button>
      <button type="button" onClick={() => clear("已重置本地草稿。")}>重置草稿</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
  </section>;
}
