"use client";

import { useEffect, useState } from "react";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningAttemptForm } from "./attempt-form";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { ObservationRevisionCard } from "./observation-revision-card";
import type { LearningObservation, LearningSummary } from "@aistudy/contracts";

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

export function CourseLearningView({ courseId }: { courseId: string }) {
  const [summary, setSummary] = useState<LearningSummary[]>([]);
  const [observations, setObservations] = useState<LearningObservation[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setState("loading");
    const client = createOpeningLearningClient();
    void Promise.all([client.getSummary(courseId), client.listObservations(courseId)]).then(([next, records]) => {
      if (!active) return;
      setSummary(next);
      setObservations(records);
      setState("ready");
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "学习证据暂时无法读取");
      setState("error");
    });
    return () => { active = false; };
  }, [courseId, revision]);

  return (
    <section className="space-y-3 border-t border-zinc-200 pt-6" aria-labelledby="opening-learning-heading">
      <div>
        <h2 id="opening-learning-heading" className="text-base font-semibold text-zinc-800">学习证据</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">这里展示服务器记录的观察，不把一次回答当作掌握证明。</p>
      </div>
      {state === "loading" ? <p className="text-sm text-zinc-500" role="status">正在读取学习证据…</p> : null}
      {state === "error" ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      {state === "ready" && summary.length === 0 ? <p className="text-sm text-zinc-500">这门课程目前没有生效的学习观察。</p> : null}
      {state === "ready" && summary.length > 0 ? (
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
          {summary.map((item) => (
            <li key={`${item.courseId ?? courseId}:${item.requirementKey ?? ""}:${item.skillLabel}`} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-3">
              <span className="min-w-0 text-sm font-medium text-zinc-800">{item.skillLabel}</span>
              <span className="text-xs text-zinc-500">{STATUS_LABEL[item.status]} · {item.sampleCount} 条观察</span>
              <span className="w-full text-xs text-zinc-500">证据来源：{item.evidenceSources?.map((source) => SOURCE_LABEL[source] ?? source).join("、") || "无"} · {item.evidenceIds.length ? `${item.evidenceIds.length} 条服务器记录` : "无"}</span>
              {item.evidenceEligibility?.map(({ observationId, eligibility, versionApplicability }, index) => <div key={observationId} className="w-full"><span className="text-xs text-zinc-500">观察 {index + 1}</span><LearningEvidenceEligibilityDetails eligibility={eligibility} versionApplicability={versionApplicability} /></div>)}
              {!item.evidenceEligibility?.length ? <p className="w-full text-xs text-zinc-500">资格信息尚未提供，保留待核验。</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {state === "ready" && observations.length > 0 ? <section className="space-y-3" aria-labelledby="opening-observations-heading">
        <h3 id="opening-observations-heading" className="text-sm font-semibold text-zinc-800">已保存的观察</h3>
        <p className="text-xs leading-5 text-zinc-500">每次原练习只计当前生效版本。纠正和撤回保留历史，不增加练习次数。</p>
        {observations.map((record) => <ObservationRevisionCard key={record.rootObservationId ?? record.id} record={record} onChanged={() => setRevision((value) => value + 1)} />)}
      </section> : null}
      <LearningAttemptForm key={courseId} courseId={courseId} onRecorded={() => setRevision((value) => value + 1)} />
    </section>
  );
}
