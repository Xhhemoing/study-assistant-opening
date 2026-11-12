"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { adaptMaterialCourseFullPackage, MaterialCourseFullPackage } from "../../../../../packages/domain/src/opening/material-course-package-adapter";

type Candidate = ReturnType<typeof adaptMaterialCourseFullPackage>;
/** Only the read-only projections needed here; never pass private answer bodies. */
export type MaterialSkillRouteData = {
  candidate: Pick<Candidate, "topics" | "routeInput" | "prerequisiteOrder" | "questionMappings" | "coverageGaps">;
  // Caller must project this from the SAME successfully validated adapter input, including
  // questionless skills. Host authorization and truthful topic membership remain caller duties;
  // this view cannot detect a forged assignment to another valid topic.
  skillTopics: Pick<MaterialCourseFullPackage["skills"][number], "id" | "topic">[];
};
export type MaterialSkillRouteViewProps = { data: MaterialSkillRouteData | null; error?: string };
const control = "rounded-lg border border-border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function MaterialSkillRouteView({ data, error }: MaterialSkillRouteViewProps) {
  const id = useId();
  const [topic, setTopic] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const choices = useRef(new Map<string, HTMLButtonElement>());
  if (error || !data) return <section aria-label="技能先修路线" className="rounded-xl border border-border p-4"><p role="alert">技能路线暂不可用，请提供有效的课程候选数据。</p></section>;

  const { candidate, skillTopics } = data;
  const requirements = candidate.routeInput.requirements;
  const byId = new Map(requirements.map(skill => [skill.externalSkillId, skill]));
  const topics = new Map(skillTopics.map(skill => [skill.id, skill.topic]));
  // Guard the joins used for rendering; graph validity remains the adapter's responsibility.
  const order = candidate.prerequisiteOrder;
  if (byId.size !== requirements.length || topics.size !== skillTopics.length || topics.size !== byId.size
    || new Set(order).size !== order.length || order.length !== byId.size || order.some(skillId => !byId.has(skillId))
    || requirements.some(skill => !topics.has(skill.externalSkillId) || !candidate.topics.includes(topics.get(skill.externalSkillId)!)
      || skill.prerequisiteSkillIds.some(parent => !byId.has(parent))
      || skill.conceptBridges.some(bridge => bridge.targetSkillId !== skill.externalSkillId || !skill.prerequisiteSkillIds.includes(bridge.prerequisiteSkillId)))) {
    return <p role="alert">技能与 topic 对应数据不完整或冲突，无法展示路线。</p>;
  }
  const ordered = candidate.prerequisiteOrder.map(skillId => byId.get(skillId)!);
  const visible = ordered.filter(skill => (topic === "all" || String(topics.get(skill.externalSkillId)) === topic)
    && `${skill.title} ${skill.externalSkillId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = visible.find(skill => skill.externalSkillId === selectedId) ?? visible[0];
  const select = (skillId: string) => setSelectedId(skillId);
  const visit = (skillId: string) => { setTopic("all"); setQuery(""); select(skillId); };
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const target = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
      : event.key === "ArrowDown" ? (index + 1) % visible.length
        : event.key === "ArrowUp" ? (index + visible.length - 1) % visible.length : null;
    if (target === null) return;
    event.preventDefault();
    const skillId = visible[target]!.externalSkillId;
    select(skillId); choices.current.get(skillId)?.focus();
  }
  const related = selected ? candidate.questionMappings.filter(question => question.primarySkillId === selected.externalSkillId || question.secondarySkillIds.includes(selected.externalSkillId)) : [];
  const diagnostics = related.filter(question => selected?.diagnosticQuestionIds.includes(question.id) && question.diagnosticEntryCandidate);
  const supplemental = related.filter(question => question.supplementalDiagnosticCandidate);
  const blocked = related.filter(question => !question.diagnosticEligible);
  const gaps = candidate.coverageGaps.filter(gap => gap.skillId === selected?.externalSkillId);
  const next = selected ? ordered.filter(skill => skill.prerequisiteSkillIds.includes(selected.externalSkillId)) : [];
  const skillLink = (skillId: string) => <button type="button" className={`${control} w-full hover:bg-muted`} onClick={() => visit(skillId)}>
    {byId.get(skillId)!.title} <span className="text-muted-foreground">· Topic {topics.get(skillId)} · 未测</span>
  </button>;

  return <section aria-labelledby={`${id}-title`} className="space-y-5 text-foreground">
    <header className="space-y-2">
      <p className="text-sm text-muted-foreground">课程候选 · 未发布 · 只读审阅模式</p>
      <h2 id={`${id}-title`} className="text-xl font-semibold">技能先修路线</h2>
      <p className="text-sm text-muted-foreground">{requirements.length} 项技能 · 按资料先修顺序浏览，不代表学习进度。</p>
      <p className="text-sm">全部未测。选择仅改变本页视图，不记录学习、不提升掌握状态或评分条件。</p>
      <p className="text-sm text-muted-foreground">此处仅审阅技能关系与题目映射，不是首答或作答页面；不展示答后提示、学习目标或常见错因。</p>
    </header>
    <div className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-topic`}>按 topic 筛选
        <select id={`${id}-topic`} className={control} value={topic} onChange={event => { setTopic(event.target.value); setSelectedId(null); }}>
          <option value="all">全部 topic</option>{candidate.topics.map(value => <option key={value} value={String(value)}>Topic {value}</option>)}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1 text-sm" htmlFor={`${id}-query`}>查找技能
        <input id={`${id}-query`} className={control} value={query} placeholder="技能名称或标识" onChange={event => { setQuery(event.target.value); setSelectedId(null); }} />
      </label>
      <button type="button" className={control} onClick={() => { setTopic("all"); setQuery(""); setSelectedId(null); }}>重置筛选</button>
    </div>
    <p role="status" className="text-sm text-muted-foreground">{visible.length} 项匹配{selected ? `；当前：${selected.title} · 未测` : "；没有匹配技能，请调整筛选。"}</p>
    <div className="grid gap-4 md:grid-cols-2">
      <nav aria-label="技能列表" className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-border p-3">
        <p className="text-xs text-muted-foreground">Tab 进入；方向键、Home / End 选择，Enter / 空格激活。</p>
        <ul className="space-y-2">{visible.map((skill, index) => <li key={skill.externalSkillId}>
          <button type="button" ref={node => { if (node) choices.current.set(skill.externalSkillId, node); else choices.current.delete(skill.externalSkillId); }}
            className={`${control} w-full hover:bg-muted ${skill === selected ? "bg-muted" : ""}`}
            aria-pressed={skill === selected} aria-controls={`${id}-detail`} tabIndex={skill === selected ? 0 : -1}
            onKeyDown={event => navigate(event, index)} onClick={() => select(skill.externalSkillId)}>
            {skill.title}<span className="block text-xs text-muted-foreground">Topic {topics.get(skill.externalSkillId)} · 未测</span>
          </button>
        </li>)}</ul>
      </nav>
      <section id={`${id}-detail`} aria-label="所选技能详情" className="space-y-4 rounded-xl border border-border p-4">
        {!selected ? <p>暂无所选技能。</p> : <>
          <h3 className="font-semibold">{selected.title} · 未测</h3>
          <p className="text-xs text-muted-foreground">{selected.externalSkillId} · Topic {topics.get(selected.externalSkillId)}</p>
          <section aria-label="直接先修" className="space-y-2"><h4 className="font-medium">直接先修</h4>
            <p className="text-sm text-muted-foreground">先修 → 当前技能。跨 topic 关系仍保留；仅展示资料中的直接边。</p>
            {selected.prerequisiteSkillIds.length ? <ul className="space-y-2">{selected.prerequisiteSkillIds.map(parent => <li key={parent}>{skillLink(parent)}</li>)}</ul> : <p className="text-sm">资料未声明直接先修，不代表已具备基础。</p>}
          </section>
          <section aria-label="下一步建议" className="space-y-2"><h4 className="font-medium">下一步建议</h4>
            <p className="text-sm">{selected.prerequisiteSkillIds.length ? "可先查看上方先修技能，核对基础；所有技能仍为未测。" : "可先核对该技能的来源与诊断候选；没有先修边不等于已通过。"} 诊断需先检查题干、答案和既往接触，再由正式流程发起；此处不可作答或评分。</p>
            {selected.conceptBridges.length > 0 && <section aria-label="可选概念桥接" className="space-y-2 text-sm">
              <h5 className="font-medium">可选概念桥接</h5>
              <p>先修未测时可先补概念，也可跳过；不计掌握，不要求先通过，不是永久门槛。这里只展示建议，不启动教学。</p>
              <ul className="space-y-2">{selected.conceptBridges.map(bridge => <li key={bridge.prerequisiteSkillId}>
                {byId.get(bridge.prerequisiteSkillId)!.title} · 未测 · {bridge.reason === "declared_measurement_gap" ? "资料声明测量缺口" : "尚无学习测量"} · 可跳过 · 不计掌握
              </li>)}</ul>
            </section>}
            <details><summary className="cursor-pointer text-sm">后续依赖（非解锁或晋级）</summary>
              {next.length ? <ul className="mt-2 space-y-2">{next.map(skill => <li key={skill.externalSkillId}>{skillLink(skill.externalSkillId)}</li>)}</ul> : <p className="text-sm">暂无直接后续依赖。</p>}
            </details>
          </section>
          <section aria-label="诊断候选与缺口" className="space-y-2"><h4 className="font-medium">诊断候选与缺口</h4>
            {diagnostics.length ? <ul className="text-sm">{diagnostics.map(question => <li key={question.id}>{question.id} · 主诊断入口候选，尚未施测，不可执行诊断</li>)}</ul> : <p className="text-sm">该技能暂无入口诊断候选；不表示能力薄弱或已经掌握。</p>}
            {supplemental.length > 0 && <ul aria-label="补充诊断候选" className="text-sm">{supplemental.map(question => <li key={question.id}>{question.id} · 补充构造题候选，尚未施测，不可执行诊断</li>)}</ul>}
            <ul className="text-sm">{blocked.map(question => <li key={question.id}>{question.id} · {question.assessmentReadiness === "blocked-author-exclusion" ? "作者排除（资料争议）" : question.assessmentReadiness === "blocked-visual-check" ? "待视觉检查" : "条件未开放"} · 排除诊断，不可评分</li>)}</ul>
            {gaps.length ? <ul className="space-y-2 text-sm">{gaps.map((gap, index) => <li key={index}>{gap.scope}<p className="text-muted-foreground">候选来源（待核对）：{gap.candidateSource}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">未声明覆盖缺口，不代表覆盖完整。</p>}
            <p className="text-xs text-muted-foreground">仅题目映射，无题干答案；独立证据条件未知，评分与 BKT 均未获准。未提供学习时长。</p>
          </section>
        </>}
      </section>
    </div>
  </section>;
}
