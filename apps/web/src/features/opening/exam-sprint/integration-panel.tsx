"use client";

import type { ExamIntegrationOverview, ExamSprintOverview } from "@aistudy/contracts";
import Link from "next/link";
import { useState } from "react";
import { ui } from "../design/ui";
import type { ExamIntegrationIntent } from "./client";
import type { ExamResources } from "./use-exam-resources";

type Send = (intent: ExamIntegrationIntent) => void;

export function IntegrationPanel({ overview, integration, resources, initialCourseId, disabled, send }: { overview: ExamSprintOverview; integration: ExamIntegrationOverview; resources: ExamResources; initialCourseId: string; disabled: boolean; send: Send }) {
  const [courseId, setCourseId] = useState(integration.binding?.courseId ?? (resources.courses.some(course => course.id === initialCourseId) ? initialCourseId : ""));
  const [milestoneId, setMilestoneId] = useState(integration.binding?.milestoneId ?? "");
  const [materials, setMaterials] = useState<Record<string, string>>(() => Object.fromEntries(integration.binding?.materials.map(item => [item.sourceTitle, `${item.sourceId}@${item.sourceVersion}`]) ?? []));
  const titles = [...new Set(overview.pack.sourceItems.map(item => item.sourceTitle))];
  const goal = resources.goals[courseId];
  function save() {
    send({ action: "bind", input: { courseId, milestoneId: milestoneId || null, expectedPackVersion: overview.pack.version, createKnowledgeNodes: true, skills: [], materials: titles.flatMap(sourceTitle => {
      const source = resources.sources.find(item => `${item.id}@${item.version}` === materials[sourceTitle]);
      if (source) return [{ sourceTitle, sourceId: source.id, sourceVersion: source.version }];
      const saved = integration.binding?.materials.find(item => item.sourceTitle === sourceTitle && `${item.sourceId}@${item.sourceVersion}` === materials[sourceTitle]);
      return saved ? [saved] : [];
    }) } });
  }
  return <div className="space-y-5"><section className={`${ui.panel} space-y-4 p-5`} aria-labelledby="sprint-binding-title"><h2 className="font-semibold" id="sprint-binding-title">关联现有课程与学习目标</h2><p className="text-xs leading-6 text-zinc-500">选择已有课程与阶段目标。导入后，预置串讲和考点进入课程；独立作答通过统一学习记录关联，不把来源自评变成已掌握。</p>
    {integration.binding ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">已关联 <Link className="font-medium underline" href={`/opening/courses/${integration.binding.courseId}`}>{resources.courses.find(course => course.id === integration.binding?.courseId)?.title ?? "查看课程"}</Link>{integration.courseGoal?.milestoneTitle ? ` · ${integration.courseGoal.milestoneTitle}` : ""}</p> : null}
    <form onSubmit={event => { event.preventDefault(); if (!disabled && courseId) save(); }} className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className={ui.label}>课程</span><select className={ui.input} required value={courseId} disabled={disabled || !!integration.binding} onChange={event => { setCourseId(event.target.value); setMilestoneId(""); }}><option value="">选择现有课程</option>{resources.courses.map(course => <option value={course.id} key={course.id}>{course.title}</option>)}</select></label><label className="space-y-1"><span className={ui.label}>已有阶段目标（可选）</span><select className={ui.input} value={milestoneId} disabled={disabled || !courseId} onChange={event => setMilestoneId(event.target.value)}><option value="">仅关联课程</option>{goal?.milestones?.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>
    {courseId ? <p className="text-xs leading-6 text-zinc-500">课程目标：{goal?.targetDate ?? "未设日期"} · 每周 {goal?.weeklyMinutes ?? "未设"} 分钟。<Link className="ml-1 text-emerald-800 underline" href={`/opening/courses/${courseId}`}>在课程页调整目标</Link></p> : <p className="text-xs text-zinc-500">没有合适的课程？<Link className="ml-1 text-emerald-800 underline" href="/opening/courses/new">先创建课程</Link></p>}
    <details className="rounded-lg border border-zinc-200 p-3"><summary className="cursor-pointer text-sm font-medium">对应真实资料 · {titles.length} 组（手动选择）</summary><p className="my-3 text-xs leading-6 text-zinc-500">只选你核对过的文件，系统不会按文件名猜测。可选择当前文件版本；已有绑定版本会保留，只有手动换选才更新。未选择的组保留为纸面索引。</p><div className="space-y-3">{titles.map(title => <label key={title} className="block space-y-1"><span className={ui.label}>{title}</span><select className={ui.input} value={materials[title] ?? ""} disabled={disabled} onChange={event => setMaterials(current => ({ ...current, [title]: event.target.value }))}><option value="">尚未关联</option>{integration.binding?.materials.filter(item => item.sourceTitle === title && !resources.sources.some(source => source.id === item.sourceId && source.version === item.sourceVersion)).map(item => <option key="saved-version" value={`${item.sourceId}@${item.sourceVersion}`}>保留已绑定版本 · v{item.sourceVersion}</option>)}{resources.sources.map(source => <option key={source.id} value={`${source.id}@${source.version}`}>{source.name} · v{source.version}</option>)}</select></label>)}</div><Link href="/opening/library?tab=materials#upload" className={`${ui.quiet} mt-3`}>前往资料库上传</Link></details>
    <button className={ui.primary} type="submit" disabled={disabled || !courseId}>{integration.binding ? "保存课程与资料关联" : "导入预置考点和串讲到课程"}</button></form></section>
    {integration.binding ? <SourceSkillMapping overview={overview} integration={integration} disabled={disabled} send={send} /> : null}
    <EvidenceLinks integration={integration} />
  </div>;
}

function SourceSkillMapping({ overview, integration, disabled, send }: { overview: ExamSprintOverview; integration: ExamIntegrationOverview; disabled: boolean; send: Send }) {
  const [sourceId, setSourceId] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const mapped = integration.sourceMappings.filter(item => item.skillIds.length > 0).length;
  return <section className={`${ui.panel} space-y-3 p-5`}><h2 className="font-semibold">原题考点映射 · 已确认 {mapped} 项</h2><p className="text-xs leading-6 text-zinc-500">根据原题内容手动选择考点；未映射的来源自评仍保存，但不会被猜测归入某项技能。</p><label className="block space-y-1"><span className={ui.label}>选择原题</span><select value={sourceId} className={ui.input} disabled={disabled} onChange={event => { setSourceId(event.target.value); setSkillIds(integration.sourceMappings.find(item => item.sourceItemId === event.target.value)?.skillIds ?? []); }}><option value="">选择题号与来源</option>{overview.pack.sourceItems.map(item => <option key={item.id} value={item.id}>{item.label} · {item.sourceTitle}</option>)}</select></label><fieldset disabled={disabled || !sourceId} className="grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-xs text-zinc-500">本题实际考查的技能（可多选）</legend>{overview.skills.map(skill => <label className="flex items-start gap-2 text-sm leading-6" key={skill.skillId}><input type="checkbox" className="mt-1 accent-emerald-700" checked={skillIds.includes(skill.skillId)} onChange={event => setSkillIds(current => event.target.checked ? [...current, skill.skillId] : current.filter(id => id !== skill.skillId))} />{skill.title}</label>)}</fieldset><button type="button" className={ui.secondary} disabled={disabled || !sourceId || !skillIds.length} onClick={() => send({ action: "map", input: { sourceItemId: sourceId, skillIds } })}>保存本题考点映射</button></section>;
}

export function EvidenceLinks({ integration }: { integration: ExamIntegrationOverview }) {
  const published = integration.links.filter(item => item.publication === "published").length;
  return <details className={`${ui.panel} p-4`}><summary className="cursor-pointer text-sm font-medium">统一学习证据 · 已关联 {published} 次 · 等待完成 {integration.links.length - published} 次</summary><p className="mt-3 text-xs leading-6 text-zinc-500">模拟交卷前只显示待发布状态，不展示正确性。以下编号用于导出核对和问题反馈。</p><ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">{integration.links.map(item => <li key={item.examAttemptId} className="rounded-lg bg-zinc-50 p-3 text-xs leading-6"><p>{item.publication === "published" ? "已关联学习记录" : item.publication === "pending_mock" ? "等待模拟交卷" : "等待作答"}</p><p className="break-all text-zinc-500">冲刺记录 {item.examAttemptId} → 学习记录 {item.learningAttemptId}</p>{item.observationId ? <p className="break-all text-zinc-500">观察 {item.observationId}</p> : null}</li>)}</ul></details>;
}
