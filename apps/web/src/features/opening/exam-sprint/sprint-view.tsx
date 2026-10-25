"use client";

import type { ExamMode, ExamSprintOverview } from "@aistudy/contracts";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EmptyState, LoadingRows, LoadError, PageHeader, ui } from "../design/ui";
import { ActiveRun, CompletedRun } from "./active-run";
import { createExamSprintClient, type ExamSprintIntent } from "./client";
import { SkillsAndLessons, SprintSettings, WeekPlan } from "./learning-plan";
import { EXAM_SPRINT_EXPORT, hasSprintAttemptHelp, modeLabels } from "./labels";
import { IntegrationPanel } from "./integration-panel";
import { BktPanel } from "./bkt-panel";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { ForecastPanel } from "./forecast-panel";
import { useExamResources } from "./use-exam-resources";
import { LearnerStateCard } from "../teaching/learner-state-card";
import { SourceTracker } from "./source-tracker";
import { sprintCourseScope } from "./sprint-course-route";

import { LessonButton } from "./lesson-button";
import { confirmedSprintLesson, confirmedSprintLessonRequest, focusSprintTarget, prepareSprintLesson, revealSprintLesson, type LessonReturnTarget, type OpenLessonIntent, type OpenSprintLesson } from "./lesson-navigation";

const tabs = [{ id: "practice", label: "当前训练" }, { id: "plan", label: "七天计划" }, { id: "sources", label: "原题登记" }, { id: "lessons", label: "技能与串讲" }, { id: "integration", label: "课程与证据" }, { id: "estimates", label: "表现估计" }, { id: "forecast", label: "考点分析" }] as const;
type Tab = typeof tabs[number]["id"];
type LessonRequest = { intent: OpenLessonIntent; returnTarget: LessonReturnTarget; returnTab: Tab };
type LessonNavigation = LessonRequest & { exposureId: string; open: boolean };

function SprintSummary({ overview }: { overview: ExamSprintOverview }) {
  const diagnostics = useDiagnosticsEnabled();
  const helped = overview.attempts.filter(attempt => attempt.answeredAt && hasSprintAttemptHelp(attempt)).length;
  return <section className={`${ui.panel} p-4`} aria-label="冲刺学习进度"><div className="grid grid-cols-3 gap-3"><div><p className="text-xl font-semibold tabular-nums">{overview.summary.onlineAnswered}</p><p className="mt-1 text-xs text-text-3">完成练习</p></div><div><p className="text-xl font-semibold tabular-nums">{overview.summary.sourceCovered}<span className="text-xs font-normal text-text-3"> / {overview.summary.sourceTotal}</span></p><p className="mt-1 text-xs text-text-3">原题已尝试 / 总项数</p></div><div><p className="text-xl font-semibold tabular-nums">{overview.summary.sourceDelayed}</p><p className="mt-1 text-xs text-text-3">完成隔日复习（自评）</p></div></div>{diagnostics ? <details className="mt-4 border-t border-line pt-3"><summary className="min-h-11 cursor-pointer text-xs text-text-3 py-2">如何理解这些记录</summary><p className="mt-2 text-xs leading-6 text-text-2">在线含帮助作答 {helped} 次；来源独立正确（自评）{overview.summary.sourceIndependent} 项。只阅读不会增加原题已尝试数。在线独立证据还要求首次见到该题族，重复做对不重复累计；登记、独立正确、隔日保持是不同证据；系统不会把“看懂”或“登记过”当成掌握，也不承诺考试分数。</p></details> : null}</section>;
}

function StartTraining({ overview, disabled, send }: { overview: ExamSprintOverview; disabled: boolean; send: (command: ExamSprintIntent) => void }) {
  const hasDiagnostic = overview.state.runs.some(run => run.mode === "diagnostic" && run.completedAt);
  const primaryMode: ExamMode = hasDiagnostic ? (overview.recommendations[0]?.mode ?? "practice") : "diagnostic";
  return <section className={`${ui.panel} space-y-4 p-5`} aria-labelledby="sprint-start-title"><div><h2 id="sprint-start-title" className="font-semibold">{hasDiagnostic ? "继续补薄弱点，再做独立复测" : "先做一轮摸底，找到这周的起点"}</h2><p className="mt-2 max-w-2xl text-sm leading-7 text-text-2">{hasDiagnostic ? "根据真实作答安排下一组训练。不会的地方先看串讲，用新的题目验证是否能独立完成。" : "无需等待 AI 出题。预置中文串讲与客观题可直接练，原资料中的题目可逐项登记和复测。"}</p></div><button type="button" className={ui.primary} disabled={disabled} onClick={() => send({ action: "start", mode: primaryMode })}>开始{modeLabels[primaryMode]}</button><details className="border-t border-line pt-3"><summary className="min-h-11 cursor-pointer text-xs font-medium text-text-2 py-2">选择其他训练</summary><div className="mt-3 flex flex-wrap gap-2">{(["diagnostic", "practice", "retest", "mock-a", "mock-b"] as const).filter(mode => mode !== primaryMode).map(mode => <button key={mode} type="button" className={ui.secondary} disabled={disabled || (mode.startsWith("mock") && overview.state.runs.some(run => run.mode === mode))} onClick={() => send({ action: "start", mode })}>{modeLabels[mode]}{mode.startsWith("mock") && overview.state.runs.some(run => run.mode === mode) ? " · 已使用" : ""}</button>)}</div><p className="mt-3 text-xs leading-6 text-text-3">模拟 A/B 各可开启一次，为约 20–30 分钟短模拟，交卷后显示解析。完整 120 分钟训练卷仍需扩充题包；这里不提供正式考试预测。</p></details></section>;
}

export function ExamSprintView({ courseId, embedded = false }: { courseId?: string; embedded?: boolean }) {
  const diagnostics = useDiagnosticsEnabled();
  const objectHref = useConversationObjectHref();
  const [client] = useState(() => createExamSprintClient());
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [tab, setTab] = useState<Tab>(courseId ? "integration" : "practice");
  useEffect(() => { if (!diagnostics && tab === "estimates") setTab("practice"); }, [diagnostics, tab]);
  const [lessonNavigation, setLessonNavigation] = useState<LessonNavigation | null>(null);
  const focusedLessonNavigation = useRef<LessonNavigation | null>(null);
  const pendingLesson = useRef<LessonRequest | null>(null);
  const [lessonError, setLessonError] = useState<string | null>(null);
  const [returnNavigation, setReturnNavigation] = useState<LessonReturnTarget | null>(null);
  const [resourcesEnabled, setResourcesEnabled] = useState(false);
  const resourceState = useExamResources(resourcesEnabled);
  useEffect(() => { void client.load(); return () => client.dispose(); }, [client]);
  const { overview, integration, forecast, review, busy, uncertain, error } = snapshot;
  const scope = sprintCourseScope(courseId, integration === null ? undefined : integration.binding);
  const overviewReady = overview !== null;
  useEffect(() => {
    if (!overviewReady) return;
    if (["integration", "sources", "forecast"].includes(tab)) setResourcesEnabled(true);
    if (["integration", "sources", "estimates"].includes(tab) || (tab !== "forecast" && integration === null)) void client.loadIntegration();
    if (tab === "forecast") void client.loadForecast();
  }, [client, tab, overviewReady]);
  const reloadCurrent = () => { if (!overview) { void client.load(); return; } if (!integration && tab !== "forecast") { void client.loadIntegration(); return; } if (["integration", "sources", "estimates"].includes(tab)) void client.loadIntegration(); else if (tab === "forecast") void client.loadForecast(forecast?.teacher ?? ""); else void client.load(); };
  const lessonContent = overview && lessonNavigation?.open ? confirmedSprintLesson(overview, lessonNavigation.intent) : null;
  const visibleLessonContent = lessonContent?.exposureId === lessonNavigation?.exposureId ? lessonContent : null;
  useEffect(() => {
    if (overview && lessonNavigation && !confirmedSprintLesson(overview, lessonNavigation.intent)) setLessonNavigation(null);
  }, [overview, lessonNavigation]);
  useEffect(() => {
    if (tab !== "lessons" || !lessonNavigation?.open || !visibleLessonContent || focusedLessonNavigation.current === lessonNavigation) return;
    if (!revealSprintLesson(document, lessonNavigation.intent.lessonId)) focusSprintTarget(document, "sprint-lessons-title");
    focusedLessonNavigation.current = lessonNavigation;
  }, [tab, lessonNavigation, visibleLessonContent]);
  useEffect(() => {
    if (!returnNavigation) return;
    if (!focusSprintTarget(document, returnNavigation.id)) focusSprintTarget(document, `sprint-tab-${tab}`);
    setReturnNavigation(null);
  }, [tab, returnNavigation]);
  const acceptLesson = (request: LessonRequest, result: ExamSprintOverview) => {
    const content = confirmedSprintLessonRequest(request, pendingLesson.current, result, client.getSnapshot().overview);
    if (pendingLesson.current !== request) return;
    pendingLesson.current = null;
    if (!content) return;
    setLessonNavigation({ ...request, exposureId: content.exposureId, open: true });
    setTab("lessons");
  };
  const openLesson: OpenSprintLesson = async (lessonId, returnTarget) => {
    if ((courseId && scope !== "match") || !overview || busy || uncertain || client.getSnapshot().busy || client.getSnapshot().uncertain || pendingLesson.current) return;
    const intent = prepareSprintLesson(overview, lessonId);
    if (!intent) { setLessonError("对应串讲暂不可用，请核对题包与训练状态。"); return; }
    const request: LessonRequest = { intent, returnTarget: tab === "lessons" && lessonNavigation ? lessonNavigation.returnTarget : returnTarget, returnTab: tab === "lessons" && lessonNavigation ? lessonNavigation.returnTab : tab };
    pendingLesson.current = request;
    setLessonError(null);
    const result = await client.send(intent);
    if (result) acceptLesson(request, result);
    else if (!client.getSnapshot().uncertain && pendingLesson.current === request) pendingLesson.current = null;
  };
  const recover = async () => {
    const request = pendingLesson.current;
    const result = await client.recover();
    if (request && result) acceptLesson(request, result);
  };
  const selectTab = (next: Tab) => {
    pendingLesson.current = null;
    setLessonNavigation(null);
    setLessonError(null);
    setTab(next);
  };
  const returnFromLesson = () => {
    if (!lessonNavigation) return;
    pendingLesson.current = null;
    setTab(lessonNavigation.returnTab);
    setReturnNavigation(lessonNavigation.returnTarget);
    setLessonNavigation(null);
  };
  const disabled = busy || uncertain;
  const send = (command: ExamSprintIntent) => { if (courseId && scope !== "match") return; if (command.action === "start") selectTab("practice"); void client.send(command); };
  return <>{!embedded ? <PageHeader title="考前冲刺" actions={<div className="flex gap-2"><button type="button" className={ui.quiet} disabled={busy} onClick={reloadCurrent}><RefreshCw size={14} aria-hidden="true" />刷新进度</button>{overview ? <a href={EXAM_SPRINT_EXPORT.href} className={ui.secondary} download={EXAM_SPRINT_EXPORT.filename} type="application/json"><Download size={14} aria-hidden="true" />导出学习记录</a> : null}</div>} /> : <div className="flex flex-wrap gap-2 py-3"><h2 className="mr-auto py-2 text-base font-semibold">题包训练</h2><button type="button" className={ui.quiet} disabled={busy} onClick={reloadCurrent}>刷新题包记录</button>{overview ? <a href={EXAM_SPRINT_EXPORT.href} className={ui.secondary} download={EXAM_SPRINT_EXPORT.filename} type="application/json">导出学习记录</a> : null}</div>}
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-5 sm:px-7">
      {error ? <div role="alert" className="space-y-3 rounded-xl border border-warn/30 bg-warn-soft p-4"><p className="text-sm leading-6 text-warn">{error}</p><button type="button" className={ui.secondary} disabled={busy} onClick={() => { if (uncertain) void recover(); else reloadCurrent(); }}>{uncertain ? "核对进度并恢复上一操作" : "重新读取进度"}</button>{uncertain ? <p className="text-xs leading-6 text-warn">其他写入暂时暂停。恢复时先核对服务器，再用同一操作标识确认；不要刷新整个页面或重复登记。</p> : null}</div> : null}
      {lessonError ? <p role="alert" className="text-sm text-warn">{lessonError}</p> : null}
      {busy ? <p role="status" className="text-xs text-text-3">正在同步学习记录…</p> : null}
      {!overview ? (!error ? <LoadingRows label="正在读取考前冲刺进度" /> : null) : courseId && scope !== "match" ? <>
        {scope === "loading" && !error ? <LoadingRows label="正在核对冲刺题包的实际课程关联…" /> : null}
        {scope === "other" ? <EmptyState title="冲刺题包已关联另一门课程" description="这个题包共用一份训练记录。当前课程不会接收另一门课程的冲刺进展，请进入已关联课程继续。" action={<Link className={ui.primary} href={objectHref(`/opening/courses/${encodeURIComponent(integration!.binding!.courseId)}?mode=sprint`)}>进入已关联课程</Link>} /> : null}
        {scope === "unbound" ? <>
          <p className="rounded-xl bg-surface-2 p-4 text-sm leading-6 text-text-2">此题包尚未关联课程。先确认课程与资料关联，再开始训练；原有题包记录会继续保留。</p>
          {resourceState.error ? <LoadError message={resourceState.error} onRetry={resourceState.reload} /> : null}
          {resourceState.resources && integration ? <IntegrationPanel key="unbound" overview={overview} integration={integration} resources={resourceState.resources} initialCourseId={courseId} disabled={disabled} send={intent => { void client.sendIntegration(intent); }} /> : !resourceState.error ? <LoadingRows label="正在读取课程与资料…" /> : null}
        </> : null}
      </> : <>
        {overview.activeRun ? <ActiveRun key={overview.activeRun.id} overview={overview} disabled={disabled} send={send} onOpenLesson={openLesson} /> : <StartTraining overview={overview} disabled={disabled} send={send} />}
        <SprintSummary overview={overview} />
        {integration?.binding ? <details className="text-xs text-text-2"><summary className="min-h-11 cursor-pointer py-1">查看课程的共同学习证据</summary><LearnerStateCard courseId={integration.binding.courseId} revision={overview.attempts.filter(item => item.answeredAt).length} /></details> : null}
        {integration === null ? <p className="text-xs text-text-3">正在确认课程关联，目标设置暂不可编辑。</p> : integration.binding ? <section className={`${ui.panel} p-4 text-xs leading-6 text-text-2`}><p>当前使用课程目标：{integration.courseGoal?.targetDate ?? "未设日期"} · 每周 {integration.courseGoal?.weeklyMinutes ?? "未设"} 分钟{integration.courseGoal?.milestoneTitle ? ` · ${integration.courseGoal.milestoneTitle}` : ""}</p><p>冲刺与其他学习任务共用课程规划的时间预算。</p><Link className={`${ui.quiet} mt-2`} href={objectHref(`/opening/courses/${integration.binding.courseId}`)}>查看课程并调整目标</Link></section> : <SprintSettings key={`${overview.state.examDate}-${overview.state.dailyMinutes}`} overview={overview} disabled={disabled} send={send} />}
        <div role="tablist" aria-label="冲刺工具" className={`${ui.segment} overflow-x-auto`}>{tabs.filter(item => diagnostics || item.id !== "estimates").map(item => <button key={item.id} type="button" role="tab" id={`sprint-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`sprint-panel-${item.id}`} aria-pressed={tab === item.id} disabled={busy} className={`${ui.segmentItem} whitespace-nowrap`} onClick={() => selectTab(item.id)}>{item.label}</button>)}</div>
        <div role="tabpanel" id="sprint-panel-practice" aria-labelledby="sprint-tab-practice" hidden={tab !== "practice"} className="space-y-5">
          <CompletedRun overview={overview} disabled={disabled} send={send} onOpenLesson={openLesson} />{overview.recommendations.length ? <section className={`${ui.panel} p-5`}><h2 className="font-semibold">下一步建议</h2><div className="mt-3 space-y-3">{overview.recommendations.slice(0, 3).map((item, index) => <div key={index} id={`sprint-recommendation-${index}`} tabIndex={-1} className="scroll-mt-24 flex flex-wrap items-start justify-between gap-3 rounded-lg bg-surface-2 p-3"><div className="max-w-xl"><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs leading-6 text-text-3">{item.reason}</p></div><div className="flex flex-wrap gap-2">{item.lessonId ? <LessonButton overview={overview} disabled={disabled} lessonId={item.lessonId} onOpenLesson={openLesson} returnTarget={{ id: `sprint-recommendation-${index}`, label: "返回学习建议" }} label="查看串讲" /> : null}<button type="button" className={ui.secondary} disabled={disabled || !!overview.activeRun} onClick={() => send({ action: "start", mode: item.mode })}>开始{modeLabels[item.mode]}</button></div></div>)}</div></section> : null}
        </div>
        {tab !== "practice" ? <div role="tabpanel" id={`sprint-panel-${tab}`} aria-labelledby={`sprint-tab-${tab}`} className="space-y-5">
          {tab === "plan" ? <WeekPlan overview={overview} bound={!!integration?.binding} /> : null}
          {tab === "sources" ? <SourceTracker overview={overview} disabled={disabled} send={send} reviewContext={{ integration, resources: resourceState.resources, review, send: intent => { void client.sendIntegration(intent); }, refresh: id => { void client.loadReview(id); } }} /> : null}
          {tab === "lessons" ? <>{lessonNavigation ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 p-3"><p role="status" className="text-sm text-text-2">已打开对应串讲。阅读后可返回原位置。</p><button type="button" className={`${ui.secondary} whitespace-normal`} onClick={returnFromLesson}>{lessonNavigation.returnTarget.label}</button></div> : null}<SkillsAndLessons overview={overview} disabled={disabled} send={send} onOpenLesson={openLesson} lessonContent={visibleLessonContent} onCloseLesson={() => setLessonNavigation(previous => previous ? { ...previous, open: false } : null)} /></> : null}
          {["sources", "integration", "forecast"].includes(tab) && resourceState.error ? <LoadError message={resourceState.error} onRetry={resourceState.reload} /> : null}
          {["sources", "integration", "forecast"].includes(tab) && resourceState.loading ? <p role="status" className="text-xs text-text-3">正在读取已有课程与资料…</p> : null}
          {tab === "integration" ? integration && resourceState.resources ? <IntegrationPanel key={integration.binding?.boundAt ?? "unbound"} overview={overview} integration={integration} resources={resourceState.resources} initialCourseId={courseId ?? ""} disabled={disabled} send={intent => { void client.sendIntegration(intent); }} /> : !error && !resourceState.error ? <LoadingRows label="正在读取课程关联" /> : null : null}
          {tab === "estimates" ? integration ? <BktPanel overview={overview} integration={integration} /> : !error ? <LoadingRows label="正在读取表现估计" /> : null : null}
          {tab === "forecast" ? forecast && resourceState.resources ? <ForecastPanel forecast={forecast} overview={overview} resources={resourceState.resources} disabled={disabled} send={intent => { void client.sendIntegration(intent); }} onFilter={teacher => { void client.loadForecast(teacher); }} /> : !error && !resourceState.error ? <LoadingRows label="正在读取考点依据" /> : null : null}
        </div> : null}
        <details className="rounded-lg border border-line p-4 text-xs text-text-3"><summary className="min-h-11 cursor-pointer py-2">题包范围与使用说明</summary><p className="mt-3 leading-6">{overview.pack.description}</p><ul className="mt-2 list-disc space-y-1 pl-5 leading-6">{overview.pack.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul><p className="mt-2">题包版本：{overview.pack.version}</p></details>
      </>}
    </div>
  </>;
}
