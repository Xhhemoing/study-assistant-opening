"use client";

import { useEffect, useMemo, useState } from "react";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { summarizeLearningAggregate } from "@aistudy/domain";
import { LearningAttemptForm } from "./attempt-form";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { CourseHistory } from "./course-history";
import { createCourseSummaryController, emptyCourseSummary, type CourseSummaryState } from "./course-summary-state";
import { findRetestPrefill, parseRetestCandidateId, type RetestAttemptPrefill } from "./retest-attempt";
import { collectSkillLabelOptions } from "./skill-label-options";
import { LoadError, secondaryButtonClass } from "../design/ui";
import type { LearningSummary } from "@aistudy/contracts";
import type { LearningSummaryAggregate } from "@aistudy/contracts";

const STATUS_LABEL: Record<LearningSummary["status"], string> = {
  unobserved: "尚无观察",
  needs_check: "需要核验",
  observed_independent: "观察到独立完成",
  needs_review: "需要复习",
};
const SOURCE_LABEL: Record<string, string> = {
  self_report: "自报",
  reference_checked: "记录为参考核对（资格另列）",
  model_suggestion: "模型建议",
  unknown: "未知",
};

function formatEvidenceTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function resultLabel(item: LearningSummary): string {
  if (item.recentPerformance && item.status === "observed_independent") return "最近观察到独立完成";
  if (item.recentPerformance && item.status === "needs_check") return "最近一次需要核验";
  return STATUS_LABEL[item.status];
}

function nextStep(item: LearningSummary): string {
  if (item.status === "needs_review") return item.recentPerformance?.status === "observed_independent"
    ? "近期已有独立完成观察；仍需完成到期复习，确认间隔后的表现。"
    : "完成到期复习，确认间隔后的表现。";
  if (item.status === "observed_independent") return "换一道题独立完成，继续确认；一次成功不代表掌握。";
  if (item.status === "needs_check") return "先查看来源与资格，确认记录后再继续练习。";
  return "先完成一次自己的尝试，再记录结果。";
}

export function CourseLearningView({ courseId, retest: retestProp = null }: { courseId: string; retest?: RetestAttemptPrefill | null }) {
  const [revision, setRevision] = useState(0);
  const [retest, setRetest] = useState<RetestAttemptPrefill | null>(retestProp);
  const [retestNotice, setRetestNotice] = useState("");
  const [skillLabels, setSkillLabels] = useState<string[]>([]);

  useEffect(() => {
    if (retestProp) { setRetest(retestProp); setRetestNotice(""); return; }
    const candidateId = parseRetestCandidateId(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("retest") : null);
    if (!candidateId) { setRetest(null); setRetestNotice(""); return; }
    let active = true;
    setRetestNotice("正在读取补测预填…");
    void createOpeningApi().listTasks().then(({ tasks }) => {
      if (!active) return;
      const found = findRetestPrefill(tasks, candidateId);
      if (found) { setRetest(found); setRetestNotice(""); }
      else { setRetest(null); setRetestNotice("找不到对应的补测任务，请从今天页重新进入。"); }
    }).catch((reason: unknown) => {
      if (!active) return;
      setRetest(null);
      setRetestNotice(reason instanceof Error ? reason.message : "无法读取补测预填");
    });
    return () => { active = false; };
  }, [courseId, retestProp]);

  useEffect(() => {
    let active = true;
    void createOpeningLearningClient().getSummary(courseId).then((rows) => {
      if (active) setSkillLabels(collectSkillLabelOptions(rows));
    }).catch(() => { if (active) setSkillLabels([]); });
    return () => { active = false; };
  }, [courseId, revision]);

  return (
    <div className="space-y-6">
      <section id="course-practice" className="scroll-mt-6 space-y-3" aria-labelledby="course-practice-heading">
        <div><h2 id="course-practice-heading" className="text-sm font-semibold text-zinc-800">{retest ? "补测作答" : "独立练习"}</h2><p className="mt-1 text-xs leading-6 text-zinc-500">{retest ? "按补测提示完成作答；提交后由服务器关闭补测活动并标记任务完成，前端只重新读取。" : "选一个主题，用自己的话回忆或完成一道题；先保留自己的尝试，再对照参考核对，需要时再使用练习辅导。"}</p></div>
        {retestNotice ? <p className="text-xs leading-6 text-amber-800" role="status">{retestNotice}</p> : null}
        <LearningAttemptForm key={`${courseId}:${retest?.retestId ?? "practice"}`} courseId={courseId} retest={retest} skillLabels={skillLabels} onRecorded={() => setRevision((value) => value + 1)} />
      </section>
      <CourseSummaryPanel key={`${courseId}:${revision}`} courseId={courseId} />
    </div>
  );
}

const aggregateStatusLabel: Record<ReturnType<typeof summarizeLearningAggregate>["recentComparableEvidence"]["status"], string> = {
  unobserved: "尚无可用观察",
  needs_check: "需要核验当前证据",
  observed_independent: "近期观察到独立完成",
};

function aggregateNextStep(summary: ReturnType<typeof summarizeLearningAggregate>): string {
  if (summary.nextAction === "complete_due_check") return "有到期核验，请先完成核验活动。";
  if (summary.nextAction === "continue_check") return "已有进行中的核验，完成后再读取新的结论。";
  if (summary.nextAction === "record_attempt") return "先完成一次自己的尝试，再记录结果。";
  if (summary.nextAction === "continue_independent") return "换一道题独立完成，继续确认；一次成功不代表掌握。";
  return "先查看来源与资格，确认记录后再继续练习。";
}

function SummaryGroup({ group }: { group: LearningSummaryAggregate }) {
  const conclusion = summarizeLearningAggregate(group);
  const sourceLabels = group.evidenceSources.join("、") || "无";
  return <li className="space-y-2 border-b border-zinc-200 py-4 last:border-b-0">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="min-w-0 text-sm font-medium text-zinc-800">{group.identity.skillLabel}</h3>
      <span className="text-xs text-zinc-500">{aggregateStatusLabel[conclusion.recentComparableEvidence.status]} · {group.sampleCount} 条观察</span>
    </div>
    <p className="text-xs leading-6 text-zinc-600">{aggregateNextStep(conclusion)} <a href="#course-practice" className="font-medium text-emerald-800 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-emerald-700">继续独立练习</a></p>
    <details className="text-xs text-zinc-500">
      <summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-emerald-700">查看来源、资格与核验计数</summary>
      <dl className="grid gap-1 py-2 leading-5 sm:grid-cols-2">
        <div><dt className="inline">近期可比较证据：</dt><dd className="inline">{conclusion.recentComparableEvidence.qualifiedCount} / {conclusion.recentComparableEvidence.evidenceCount} 条符合资格</dd></div>
        <div><dt className="inline">更早的独立核验正确：</dt><dd className="inline">{conclusion.historicalSuccess.count} 条</dd></div>
        <div><dt className="inline">适用性：</dt><dd className="inline">精确 {group.applicabilityCounts.exact} · 等价 {group.applicabilityCounts.equivalent_confirmed} · 需重新核验 {group.applicabilityCounts.changed_needs_check} · 版本未知 {group.applicabilityCounts.version_unknown} · 不可用 {group.applicabilityCounts.unavailable}</dd></div>
        <div><dt className="inline">核验活动：</dt><dd className="inline">已接受 {group.openChecks.acceptedCount} · 进行中 {group.openChecks.inProgressCount} · 到期 {group.openChecks.dueCount}</dd></div>
      </dl>
      <p className="py-1 leading-5">证据来源：{sourceLabels} · {group.representatives.length ? `${group.representatives.length} 条代表证据` : "无代表证据"}</p>
      {group.representatives.map((representative, index) => <div key={representative.observationId} className="py-1"><span className="break-all">代表观察 {index + 1} · 观察 ID：{representative.observationId} · 记录时间：<time dateTime={new Date(representative.attemptAt).toISOString()}>{formatEvidenceTime(representative.attemptAt)}</time></span><LearningEvidenceEligibilityDetails eligibility={representative.eligibility} versionApplicability={representative.versionApplicability} /></div>)}
      {!group.representatives.length ? <p className="py-1">资格信息尚未提供，保留待核验。</p> : null}
    </details>
  </li>;
}

export function CourseSummaryNotice({ state, onRefresh }: { state: CourseSummaryState; onRefresh: () => void }) {
  if (!state.notice) return null;
  const stalled = state.status === "updating" && state.notice.includes("手动刷新");
  return <div className="flex flex-wrap items-center gap-3" role="status">
    <p className="text-xs leading-6 text-amber-800">{state.notice}</p>
    {stalled ? <button type="button" className={secondaryButtonClass} onClick={onRefresh}>刷新摘要</button> : null}
  </div>;
}

export function CourseSummaryPanel({ courseId }: { courseId: string }) {
  const [state, setState] = useState<CourseSummaryState>(emptyCourseSummary);
  const controller = useMemo(() => createCourseSummaryController(createOpeningLearningClient().getSummaryPage,
    { courseId }, setState), [courseId]);
  useEffect(() => { void controller.start(); return () => controller.cancel(); }, [controller]);
  const requirements = [...new Set(state.groups.flatMap(group => group.identity.requirementKey === null ? [] : [group.identity.requirementKey]))];
  const busy = state.status === "loading" || state.status === "loading_more";
  return <section id="course-learning-records" className="scroll-mt-6 space-y-3 border-t border-zinc-200 pt-5" aria-labelledby="opening-learning-heading">
    <div><h2 id="opening-learning-heading" className="text-sm font-semibold text-zinc-800">学习记录与证据</h2><p className="mt-1 text-sm leading-6 text-zinc-500">这里展示固定快照中的完整分组计数与有限代表证据，不把一次回答当作掌握证明。</p></div>
    {state.status === "loading" || state.status === "idle" ? <p className="text-sm text-zinc-500" role="status">正在读取学习证据…</p> : null}
    {state.status === "updating" ? <p className="text-sm text-amber-800" role="status">正在更新当前页的证据资格{state.pendingProjectionCount ? `（剩余 ${state.pendingProjectionCount} 条）` : ""}，完成后再显示结论。</p> : null}
    <CourseSummaryNotice state={state} onRefresh={() => void controller.refresh()} />
    {state.status === "error" ? <LoadError message={state.error} onRetry={() => void controller.refresh()} /> : null}
    {state.status === "ready" && state.groups.length === 0 ? <p className="text-sm text-zinc-500">这门课程目前没有生效的学习观察。</p> : null}
    {state.status === "ready" && state.groups.length > 0 ? <ul className="divide-y divide-zinc-200 border-y border-zinc-200">{state.groups.map(group => <SummaryGroup key={JSON.stringify([group.identity.skillLabel, group.identity.requirementKey])} group={group} />)}</ul> : null}
    {state.status === "ready" && state.nextCursor ? <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void controller.loadMore()}>{busy ? "正在读取下一页…" : "继续加载摘要分组"}</button> : null}
    <CourseHistory key={courseId} courseId={courseId} requirements={requirements} onChanged={() => void controller.refresh()} />
  </section>;
}

export function CourseLearningRecords({ courseId, state, error, summary, onReload }: {
  courseId: string;
  state: "loading" | "ready" | "error";
  error: string;
  summary: LearningSummary[];
  onReload: () => void;
}) {
  return (
    <section id="course-learning-records" className="scroll-mt-6 space-y-3 border-t border-zinc-200 pt-5" aria-labelledby="opening-learning-heading">
      <div>
        <h2 id="opening-learning-heading" className="text-sm font-semibold text-zinc-800">学习记录与证据</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">这里展示服务器记录的观察，不把一次回答当作掌握证明。</p>
      </div>
      {state === "loading" ? <p className="text-sm text-zinc-500" role="status">正在读取学习证据…</p> : null}
      {state === "error" ? <LoadError message={error} onRetry={onReload} /> : null}
      {state === "ready" && summary.length === 0 ? <p className="text-sm text-zinc-500">这门课程目前没有生效的学习观察。</p> : null}
      {state === "ready" && summary.length > 0 ? (
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
          {summary.map((item) => (
            <li key={`${item.courseId ?? courseId}:${item.requirementKey ?? ""}:${item.skillLabel}`} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-3">
              <span className="min-w-0 text-sm font-medium text-zinc-800">{item.skillLabel}</span>
              <span className="text-xs text-zinc-500">{resultLabel(item)} · {item.sampleCount} 条观察</span>
              <p className="w-full text-xs leading-6 text-zinc-600">{nextStep(item)} <a href="#course-practice" className="font-medium text-emerald-800 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-emerald-700">继续独立练习</a></p>
              <details className="w-full text-xs text-zinc-500"><summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-emerald-700">查看来源与资格</summary>
                {item.recentPerformance ? <p className="py-2 leading-5">近期结果依据最近的 {item.recentPerformance.evidenceCount ?? item.recentPerformance.evidenceIds.length} 条原始作答；纠正记录不增加练习次数。</p> : null}
                {item.historicalIncorrectCount !== undefined && item.unverifiedCount !== undefined ? <p className="py-2 leading-5">更早的记录中有 {item.historicalIncorrectCount} 条核验错误；当前共 {item.unverifiedCount} 条记录尚未核验。历史仍可查看。</p> : null}
                <p className="break-all py-2 leading-5">证据来源：{item.evidenceSources?.map((source) => SOURCE_LABEL[source] ?? source).join("、") || "无"} · {item.evidenceIds.length ? `${item.evidenceIds.length} 条代表证据` : "无"} · 观察 ID：{item.evidenceIds.join("、") || "无"} · 记录时间：{item.lastObservedAt ? <time dateTime={item.lastObservedAt}>{formatEvidenceTime(item.lastObservedAt)}</time> : "未知"}</p>
                {item.evidenceEligibility?.map(({ observationId, eligibility, versionApplicability }, index) => <div key={observationId} className="py-1"><span className="break-all text-xs text-zinc-500">{item.recentPerformance?.evidenceIds.includes(observationId) ? "最近代表观察" : "代表观察"} {index + 1} · 观察 ID：{observationId}</span><LearningEvidenceEligibilityDetails eligibility={eligibility} versionApplicability={versionApplicability} /></div>)}
                {!item.evidenceEligibility?.length ? <p className="text-xs text-zinc-500">资格信息尚未提供，保留待核验。</p> : null}
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      <CourseHistory key={courseId} courseId={courseId} requirements={[...new Set(summary.flatMap(item => item.requirementKey == null ? [] : [item.requirementKey]))]} onChanged={onReload} />
    </section>
  );
}
