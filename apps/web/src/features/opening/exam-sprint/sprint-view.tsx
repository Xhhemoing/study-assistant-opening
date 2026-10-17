"use client";

import type { ExamMode, ExamSprintOverview } from "@aistudy/contracts";
import Link from "next/link";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { LoadingRows, LoadError, PageHeading, ui } from "../design/ui";
import { ActiveRun, CompletedRun } from "./active-run";
import { createExamSprintClient, type ExamSprintIntent } from "./client";
import { SkillsAndLessons, SprintSettings, WeekPlan } from "./learning-plan";
import { modeLabels } from "./labels";
import { IntegrationPanel } from "./integration-panel";
import { BktPanel } from "./bkt-panel";
import { ForecastPanel } from "./forecast-panel";
import { useExamResources } from "./use-exam-resources";
import { SourceTracker } from "./source-tracker";

const tabs = [{ id: "practice", label: "当前训练" }, { id: "plan", label: "七天计划" }, { id: "sources", label: "原题登记" }, { id: "lessons", label: "技能与串讲" }, { id: "integration", label: "课程与证据" }, { id: "estimates", label: "表现估计" }, { id: "forecast", label: "考点分析" }] as const;
type Tab = typeof tabs[number]["id"];

function SprintSummary({ overview }: { overview: ExamSprintOverview }) {
  const helped = overview.attempts.filter(attempt => attempt.answeredAt && attempt.help.length > 0).length;
  return <section className={`${ui.panel} p-4`} aria-label="冲刺学习进度"><div className="grid grid-cols-3 gap-3"><div><p className="text-xl font-semibold tabular-nums">{overview.summary.onlineIndependentCorrect}<span className="text-xs font-normal text-zinc-500"> / {overview.summary.onlineAnswered}</span></p><p className="mt-1 text-xs text-zinc-500">在线独立正确 / 已答</p></div><div><p className="text-xl font-semibold tabular-nums">{overview.summary.sourceCovered}<span className="text-xs font-normal text-zinc-500"> / {overview.summary.sourceTotal}</span></p><p className="mt-1 text-xs text-zinc-500">原题已尝试 / 总项数</p></div><div><p className="text-xl font-semibold tabular-nums">{overview.summary.sourceDelayed}</p><p className="mt-1 text-xs text-zinc-500">原题隔日独立通过（自评）</p></div></div><details className="mt-4 border-t border-zinc-100 pt-3"><summary className="cursor-pointer text-xs text-zinc-500">如何理解这些记录</summary><p className="mt-2 text-xs leading-6 text-zinc-600">在线含帮助作答 {helped} 次；来源独立正确（自评）{overview.summary.sourceIndependent} 项。只阅读不会增加原题已尝试数。在线独立证据还要求首次见到该题族，重复做对不重复累计；登记、独立正确、隔日保持是不同证据；系统不会把“看懂”或“登记过”当成掌握，也不承诺考试分数。</p></details></section>;
}

function StartTraining({ overview, disabled, send }: { overview: ExamSprintOverview; disabled: boolean; send: (command: ExamSprintIntent) => void }) {
  const hasDiagnostic = overview.state.runs.some(run => run.mode === "diagnostic" && run.completedAt);
  const primaryMode: ExamMode = hasDiagnostic ? (overview.recommendations[0]?.mode ?? "practice") : "diagnostic";
  return <section className={`${ui.panel} space-y-4 p-5`} aria-labelledby="sprint-start-title"><div><h2 id="sprint-start-title" className="font-semibold">{hasDiagnostic ? "继续补薄弱点，再做独立复测" : "先做一轮摸底，找到这周的起点"}</h2><p className="mt-2 max-w-2xl text-sm leading-7 text-zinc-600">{hasDiagnostic ? "根据真实作答安排下一组训练。不会的地方先看串讲，用新的题目验证是否能独立完成。" : "无需等待 AI 出题。预置中文串讲与客观题可直接练，原资料中的题目可逐项登记和复测。"}</p></div><button type="button" className={ui.primary} disabled={disabled} onClick={() => send({ action: "start", mode: primaryMode })}>开始{modeLabels[primaryMode]}</button><details className="border-t border-zinc-100 pt-3"><summary className="cursor-pointer text-xs font-medium text-zinc-600">选择其他训练</summary><div className="mt-3 flex flex-wrap gap-2">{(["diagnostic", "practice", "retest", "mock-a", "mock-b"] as const).filter(mode => mode !== primaryMode).map(mode => <button key={mode} type="button" className={ui.secondary} disabled={disabled || (mode.startsWith("mock") && overview.state.runs.some(run => run.mode === mode))} onClick={() => send({ action: "start", mode })}>{modeLabels[mode]}{mode.startsWith("mock") && overview.state.runs.some(run => run.mode === mode) ? " · 已使用" : ""}</button>)}</div><p className="mt-3 text-xs leading-6 text-zinc-500">模拟 A/B 各可开启一次，为约 20–30 分钟短模拟，交卷后显示解析。完整 120 分钟训练卷仍需扩充题包；这里不提供正式考试预测。</p></details></section>;
}

export function ExamSprintView() {
  const [client] = useState(() => createExamSprintClient());
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [tab, setTab] = useState<Tab>("practice");
  const [initialCourseId, setInitialCourseId] = useState("");
  const [resourcesEnabled, setResourcesEnabled] = useState(false);
  const resourceState = useExamResources(resourcesEnabled);
  useEffect(() => { const courseId = new URLSearchParams(window.location.search).get("courseId"); if (courseId) { setInitialCourseId(courseId); setTab("integration"); } void client.load(); return () => client.dispose(); }, [client]);
  const { overview, integration, forecast, review, busy, uncertain, error } = snapshot;
  const overviewReady = overview !== null;
  useEffect(() => {
    if (!overviewReady) return;
    if (["integration", "sources", "forecast"].includes(tab)) setResourcesEnabled(true);
    if (["integration", "sources", "estimates"].includes(tab) || (tab !== "forecast" && integration === null)) void client.loadIntegration();
    if (tab === "forecast") void client.loadForecast();
  }, [client, tab, overviewReady]);
  const reloadCurrent = () => { if (!overview) { void client.load(); return; } if (!integration && tab !== "forecast") { void client.loadIntegration(); return; } if (["integration", "sources", "estimates"].includes(tab)) void client.loadIntegration(); else if (tab === "forecast") void client.loadForecast(forecast?.teacher ?? ""); else void client.load(); };
  const disabled = busy || uncertain;
  const send = (command: ExamSprintIntent) => { if (command.action === "start") setTab("practice"); void client.send(command); };
  return <><PageHeading title="考前冲刺" description={overview?.pack.title ?? "预置学习材料，记录真实尝试，补足薄弱点。"} actions={<div className="flex gap-2"><button type="button" className={ui.quiet} disabled={busy} onClick={reloadCurrent}><RefreshCw size={14} aria-hidden="true" />刷新进度</button>{overview ? <a href="/api/opening/exam-sprint/export" className={ui.secondary} download><Download size={14} aria-hidden="true" />导出学习记录</a> : null}</div>} />
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-5 sm:px-7">
      {error ? <div role="alert" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm leading-6 text-amber-950">{error}</p><button type="button" className={ui.secondary} disabled={busy} onClick={() => { if (uncertain) void client.recover(); else reloadCurrent(); }}>{uncertain ? "核对进度并恢复上一操作" : "重新读取进度"}</button>{uncertain ? <p className="text-xs leading-6 text-amber-900">其他写入暂时暂停。恢复时先核对服务器，再用同一操作标识确认；不要刷新整个页面或重复登记。</p> : null}</div> : null}
      {busy ? <p role="status" className="text-xs text-zinc-500">正在同步学习记录…</p> : null}
      {!overview ? (!error ? <LoadingRows label="正在读取考前冲刺进度" /> : null) : <>
        {overview.activeRun ? <ActiveRun key={overview.activeRun.id} overview={overview} disabled={disabled} send={send} /> : <StartTraining overview={overview} disabled={disabled} send={send} />}
        <SprintSummary overview={overview} />
        {integration === null ? <p className="text-xs text-zinc-500">正在确认课程关联，目标设置暂不可编辑。</p> : integration.binding ? <section className={`${ui.panel} p-4 text-xs leading-6 text-zinc-600`}><p>当前使用课程目标：{integration.courseGoal?.targetDate ?? "未设日期"} · 每周 {integration.courseGoal?.weeklyMinutes ?? "未设"} 分钟{integration.courseGoal?.milestoneTitle ? ` · ${integration.courseGoal.milestoneTitle}` : ""}</p><p>冲刺与其他学习任务共用课程规划的时间预算。</p><Link className={`${ui.quiet} mt-2`} href={`/opening/courses/${integration.binding.courseId}`}>查看课程并调整目标</Link></section> : <SprintSettings key={`${overview.state.examDate}-${overview.state.dailyMinutes}`} overview={overview} disabled={disabled} send={send} />}
        <div role="tablist" aria-label="冲刺工具" className={`${ui.segment} overflow-x-auto`}>{tabs.map(item => <button key={item.id} type="button" role="tab" id={`sprint-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`sprint-panel-${item.id}`} aria-pressed={tab === item.id} disabled={busy} className={`${ui.segmentItem} whitespace-nowrap`} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
        <div role="tabpanel" id={`sprint-panel-${tab}`} aria-labelledby={`sprint-tab-${tab}`} className="space-y-5">
          {tab === "practice" ? <><CompletedRun overview={overview} disabled={disabled} send={send} />{overview.recommendations.length ? <section className={`${ui.panel} p-5`}><h2 className="font-semibold">下一步建议</h2><div className="mt-3 space-y-3">{overview.recommendations.slice(0, 3).map((item, index) => <div key={index} className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-zinc-50 p-3"><div className="max-w-xl"><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs leading-6 text-zinc-500">{item.reason}</p></div><div className="flex gap-2">{item.lessonId ? <button type="button" className={ui.quiet} onClick={() => setTab("lessons")}>查看串讲</button> : null}<button type="button" className={ui.secondary} disabled={disabled || !!overview.activeRun} onClick={() => send({ action: "start", mode: item.mode })}>开始{modeLabels[item.mode]}</button></div></div>)}</div></section> : null}</> : null}
          {tab === "plan" ? <WeekPlan overview={overview} bound={!!integration?.binding} /> : null}
          {tab === "sources" ? <SourceTracker overview={overview} disabled={disabled} send={send} reviewContext={{ integration, resources: resourceState.resources, review, send: intent => { void client.sendIntegration(intent); }, refresh: id => { void client.loadReview(id); } }} /> : null}
          {tab === "lessons" ? <SkillsAndLessons overview={overview} disabled={disabled} send={send} /> : null}
          {["sources", "integration", "forecast"].includes(tab) && resourceState.error ? <LoadError message={resourceState.error} onRetry={resourceState.reload} /> : null}
          {["sources", "integration", "forecast"].includes(tab) && resourceState.loading ? <p role="status" className="text-xs text-zinc-500">正在读取已有课程与资料…</p> : null}
          {tab === "integration" ? integration && resourceState.resources ? <IntegrationPanel key={integration.binding?.boundAt ?? "unbound"} overview={overview} integration={integration} resources={resourceState.resources} initialCourseId={initialCourseId} disabled={disabled} send={intent => { void client.sendIntegration(intent); }} /> : !error && !resourceState.error ? <LoadingRows label="正在读取课程关联" /> : null : null}
          {tab === "estimates" ? integration ? <BktPanel overview={overview} integration={integration} /> : !error ? <LoadingRows label="正在读取表现估计" /> : null : null}
          {tab === "forecast" ? forecast && resourceState.resources ? <ForecastPanel forecast={forecast} overview={overview} resources={resourceState.resources} disabled={disabled} send={intent => { void client.sendIntegration(intent); }} onFilter={teacher => { void client.loadForecast(teacher); }} /> : !error && !resourceState.error ? <LoadingRows label="正在读取考点依据" /> : null : null}
        </div>
        <details className="rounded-lg border border-zinc-200 p-4 text-xs text-zinc-500"><summary className="cursor-pointer">题包范围与使用说明</summary><p className="mt-3 leading-6">{overview.pack.description}</p><ul className="mt-2 list-disc space-y-1 pl-5 leading-6">{overview.pack.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul><p className="mt-2">题包版本：{overview.pack.version}</p></details>
      </>}
    </div>
  </>;
}
