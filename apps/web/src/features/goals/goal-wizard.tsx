"use client";

import { ArrowLeft, ArrowRight, Check, LoaderCircle, SkipForward } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ScenarioPreset } from "@aistudy/contracts";
import { useStudyProvider } from "../../lib/data/react";
import { clampDailyMinutes, defaultGoalInput, goalPath, GOAL_WIZARD_STEPS, normalizeGoalTitle, type GoalDraft, type GoalWizardStep } from "./goal-model";
import { DailyMinutesField, ExamDateField, ScenarioPicker, SubjectPicker } from "./goal-form-fields";

const STEP_COPY: Record<GoalWizardStep, { title: string; description: string }> = {
  scenario: { title: "选择目标场景", description: "先确定这段学习要服务于什么。" },
  examDate: { title: "设定目标日期", description: "有明确日期时，计划会更容易安排。" },
  subjects: { title: "选择学习主题", description: "从种子考纲中挑选现在最相关的主题。" },
  dailyMinutes: { title: "安排每日时间", description: "从一个你能持续完成的节奏开始。" },
};

export function GoalWizard({ courseId = null }: { courseId?: string | null }) {
  const router = useRouter();
  const provider = useStudyProvider();
  const [draft, setDraft] = useState<GoalDraft>(() => defaultGoalInput(courseId));
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const step = GOAL_WIZARD_STEPS[stepIndex] ?? GOAL_WIZARD_STEPS[0];
  const isLastStep = stepIndex === GOAL_WIZARD_STEPS.length - 1;

  function updateDraft<K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submitGoal() {
    if (!provider || submitting) {
      if (!provider) setError("正在准备学习空间，请稍后再试。");
      return;
    }
    const title = normalizeGoalTitle(draft.title);
    if (!title) {
      setError("请填写目标名称。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const goal = await provider.createGoal({ ...draft, title });
      router.push(goalPath(goal.id));
    } catch {
      setError("目标创建失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  function moveNext() {
    if (isLastStep) {
      void submitGoal();
      return;
    }
    setStepIndex((current) => current + 1);
  }

  function moveBack() {
    setStepIndex((current) => Math.max(0, current - 1));
  }

  function skipStep() {
    moveNext();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    moveNext();
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-3 border-b border-line pb-6">
        <p className="text-xs text-text-dim">学习空间 / 新目标</p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">创建学习目标</h1>
        <p className="max-w-prose text-sm leading-6 text-text-dim">先给方向，再逐步补充细节。每一步都可以跳过。</p>
      </header>

      <form className="space-y-8" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <label className="text-sm font-semibold text-text" htmlFor="goal-title">目标名称</label>
          <input className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="goal-title" maxLength={80} onChange={(event) => updateDraft("title", event.target.value)} value={draft.title} />
        </div>

        <div aria-label="目标创建进度" aria-valuemax={GOAL_WIZARD_STEPS.length} aria-valuemin={1} aria-valuenow={stepIndex + 1} aria-valuetext={`第 ${stepIndex + 1} 步，共 ${GOAL_WIZARD_STEPS.length} 步`} className="grid grid-cols-4 gap-2" role="progressbar">
          {GOAL_WIZARD_STEPS.map((item, index) => (
            <div className={`h-1 rounded-full ${index <= stepIndex ? "bg-primary" : "bg-surface-2"}`} key={item} />
          ))}
        </div>

        <section aria-labelledby="goal-step-heading" className="space-y-5">
          <div className="space-y-1">
            <p className="text-xs text-text-dim">第 {stepIndex + 1} 步 / {GOAL_WIZARD_STEPS.length}</p>
            <h2 className="text-lg font-semibold text-text" id="goal-step-heading">{STEP_COPY[step].title}</h2>
            <p className="text-sm text-text-dim">{STEP_COPY[step].description}</p>
          </div>
          {step === "scenario" ? <ScenarioPicker onChange={(value: ScenarioPreset) => updateDraft("scenario", value)} value={draft.scenario} /> : null}
          {step === "examDate" ? <ExamDateField onChange={(value) => updateDraft("examDate", value)} value={draft.examDate} /> : null}
          {step === "subjects" ? <SubjectPicker onChange={(value) => updateDraft("subjects", value)} value={draft.subjects} /> : null}
          {step === "dailyMinutes" ? <DailyMinutesField onChange={(value) => updateDraft("dailyMinutes", clampDailyMinutes(value))} value={draft.dailyMinutes} /> : null}
        </section>

        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
        <div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={stepIndex === 0 || submitting} onClick={moveBack} type="button">
            <ArrowLeft aria-hidden="true" size={16} />返回
          </button>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={submitting} onClick={skipStep} type="button">
              <SkipForward aria-hidden="true" size={16} />{isLastStep ? "跳过并创建" : "跳过"}
            </button>
            <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={submitting} type="submit">
              {submitting ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : isLastStep ? <Check aria-hidden="true" size={16} /> : <ArrowRight aria-hidden="true" size={16} />}
              {submitting ? "创建中" : isLastStep ? "创建目标" : "下一步"}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
