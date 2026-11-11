"use client";

import { useId, useState } from "react";
import { readMaterialSourceReview, type MaterialSourceReviewInput } from "./material-source-review-panel-model";

/** Use only the current raw package; old candidate/postAttemptMetadata is not this contract. */
export type MaterialSourceReviewPanelProps = {
  input: MaterialSourceReviewInput | null; providedSources?: unknown;
  /** Display context only, never proof of an attempt or a first-answer admission flag. */
  purpose?: "review" | "post-attempt";
};

/** External-page locator only: no fetch, iframe, import or learning-event side effects. */
export function MaterialSourceReviewPanel({ input, providedSources, purpose = "review" }: MaterialSourceReviewPanelProps) {
  const id = useId();
  const [selection, setSelection] = useState<{ input: unknown; key: string } | null>(null);
  const [previousInput, setPreviousInput] = useState(input);
  if (previousInput !== input) {
    setPreviousInput(input);
    setSelection(null);
  }
  // Deliberately revalidate each render: a caller can mutate a raw payload in place.
  const model = readMaterialSourceReview(input, providedSources);
  if (!model) return <section aria-label="资料源定位" className="rounded-xl border border-border p-4"><p role="alert">资料源定位暂不可用，请核对资料映射与 host 绑定。</p></section>;
  const selected = model.choices.find(choice => selection !== null && selection.input === input && choice.key === selection.key) ?? model.choices[0];
  return <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-xl border border-border p-4 text-foreground">
    <h2 id={`${id}-title`} className="text-lg font-semibold">资料源定位 · 只读审阅／答后核对</h2>
    <p className="text-sm">{purpose === "post-attempt" ? "当前用途：答后核对（host 提供的展示上下文，不代表已验证作答）" : "当前用途：资料审阅（非无帮助首答）"}</p>
    <p className="text-sm">这不是首答界面。来源页可能含答案或提示；首答前查看必须在正式作答流程计为帮助（help），不能作为无帮助首答证据。本面板不记录作答或帮助事件，host 不得将其嵌为无帮助首答步骤。</p>
    <p className="text-sm text-muted-foreground">本面板不展示题干、答案、答后说明、技能学习目标或常见错因；需要查看这些内容应在资料审阅或答后流程进行。</p>
    <p className="text-sm">仅元数据，无题干答案；未测，视觉待核，数学未验证。查看来源不授予诊断、评分或 BKT 资格。</p>
    <p className="text-sm text-muted-foreground">链接仅打开 host 显式绑定的外部 PDF 物理页；未核验 PDF 字节或访问权限。</p>
    <label className="flex flex-col gap-2 text-sm" htmlFor={`${id}-choice`}>选择题目或技能
      <select id={`${id}-choice`} className="rounded-lg border border-border bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={selected?.key ?? ""} aria-controls={`${id}-detail`} onChange={event => setSelection({ input, key: event.target.value })}>
        {!model.choices.length && <option value="">暂无题目或技能</option>}
        {model.choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
      </select>
    </label>
    <p role="status" className="text-sm text-muted-foreground">{selected ? `当前：${selected.label} · 未测` : "暂无可定位项目。"}</p>
    <section id={`${id}-detail`} aria-label="所选来源详情" className="space-y-3">
      {selected && <>
        <h3 className="font-medium">{selected.label}</h3>
        <section aria-label="诊断禁用理由" className="space-y-2 text-sm">
          <h4 className="font-medium">诊断禁用理由</h4>
          <p>此处不可作答、施测、评分或写入 BKT；手工选择、查看来源或文本映射已核均不能提升资格。</p>
          {selected.questionStatuses.length ? <ul className="space-y-2">{selected.questionStatuses.map(question => <li key={question.id}>{question.id}：{question.reasons.join("；")}</li>)}</ul> : <p>没有关联题目；没有有效诊断证据，不代表已经掌握。</p>}
        </section>
        <ul className="space-y-2 text-sm">{selected.result.locations.map((location, index) => <li key={index} className="rounded-lg border border-border p-3">
          <p>{location.file} · 物理页 {location.physicalPage} / {location.pageCount}</p>
          {location.status === "located" ? <>
            <p className="break-all">sourceID：{location.sourceId} · version：{location.sourceVersion}</p>
            <a className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`${location.target.pdfUrl}${location.target.fragment}`} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开来源物理页 {location.physicalPage}（新窗口）</a>
          </> : <p>未绑定（unbound）：host 尚未提供 sourceID、version、SHA 与 HTTPS URL，无法打开来源。</p>}
          <p className="text-muted-foreground">{location.mappingStatus === "text-reviewed" ? "文本映射已核，仍待视觉核验" : "映射待视觉核验"}；sourceID 不等于 canonical family，页位置不代表 canonical family。</p>
        </li>)}</ul>
      </>}
    </section>
  </section>;
}
