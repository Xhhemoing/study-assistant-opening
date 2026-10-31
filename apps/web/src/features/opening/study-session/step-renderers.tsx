"use client";
import type { ComponentType, ReactNode } from "react";
import { LearningProse } from "../assistant/learning-prose";
import { MathInput } from "../teaching/math-input";
import { spanVectorInput, type SpanDraftAnswer } from "../teaching/span/span-answer";
import { SpanTargetedFocus } from "../teaching/span/targeted-focus";
import { SpanNoSolutionProof } from "../teaching/span/span-no-solution-proof";
import { ui } from "../design/ui";
import type { CardStep, LearnStep, PhotoState, QuestionStep, StudyStep, StudyStepKind } from "./model";

export type StepRendererProps<S extends StudyStep = StudyStep> = {
  step: S;
  answer: Partial<SpanDraftAnswer>;
  locked: boolean;
  photo: PhotoState | null;
  onEdit: (change: Partial<SpanDraftAnswer>) => void;
  onChoosePhoto: (file: File) => void;
  onRemovePhoto: () => void;
  /** Complex controls and results remain in their original owner. */
  content?: ReactNode;
  onSelectGrade?: (grade: NonNullable<CardStep["grade"]>) => void;
};

export const cardGradeOptions = [
  { grade: "again", label: "重来" }, { grade: "hard", label: "困难" },
  { grade: "good", label: "记得" }, { grade: "easy", label: "轻松" },
] as const;

function CardRenderer({ step, locked, onSelectGrade }: StepRendererProps<CardStep>) {
  return <div className="space-y-6">
    <div className="prose-reading text-lg leading-8"><LearningProse text={step.front} /></div>
    {step.flipped ? <>
      <section aria-label="参考内容" className="prose-reading rounded-tile border border-line p-4"><LearningProse text={step.back ?? ""} /></section>
      <fieldset disabled={locked} className="space-y-3"><legend className="text-sm text-text-2">这次回忆的情况（选择后再保存）</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{cardGradeOptions.map(({ grade, label }) =>
          <button key={grade} type="button" className={ui.secondary} aria-pressed={step.grade === grade} onClick={() => onSelectGrade?.(grade)}>{label}</button>)}</div>
      </fieldset>
    </> : <p className="text-sm text-text-2">先在心里回忆，再翻面核对。</p>}
  </div>;
}

function LearnRenderer({ step }: StepRendererProps<LearnStep>) {
  return <div className="space-y-4">
    <SpanTargetedFocus text={step.focus} />
    <div className="prose-reading text-base leading-8"><LearningProse text={step.body} /></div>
  </div>;
}

const vectorText = (values?: string[]) => values?.join(", ") ?? "";

/**
 * span answer form. The membership judgement and coefficients come first; the full working
 * (equation, coordinate checks, structure) is optional and folded, the same fields as the legacy form.
 */
function SpanQuestionRenderer({ step, answer, locked, photo, onEdit, onChoosePhoto, onRemovePhoto }: StepRendererProps<QuestionStep>) {
  const equation = answer.equation ?? { vectors: [[], []] as [string[], string[]], target: [] as string[] };
  const coefficients = answer.coefficients ?? ["", ""];
  const checks = <label className="block text-xs">代回后 αv+βw 的各坐标
    <input className={`${ui.input} mt-1`} maxLength={1400} value={vectorText(answer.coordinateChecks)} onChange={event => onEdit({ coordinateChecks: spanVectorInput(event.target.value) })} />
  </label>;
  return <div className="space-y-6">
    <div className="prose-reading text-lg leading-8"><LearningProse text={step.prompt} /></div>
    <fieldset disabled={locked} className="space-y-4">
      <legend className="sr-only">你的作答</legend>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">我的判断
          <select className={`${ui.input} mt-1`} value={answer.membership ?? ""} required onChange={event => onEdit({ membership: event.target.value as SpanDraftAnswer["membership"] })}>
            <option value="" disabled>选择</option><option value="in_span">属于 span</option><option value="not_in_span">不属于 span</option>
          </select>
        </label>
        {(["α", "β"] as const).map((label, index) => <label key={label} className="block w-28 text-sm">{label}
          <input className={`${ui.input} mt-1`} inputMode="decimal" maxLength={160} value={coefficients[index] ?? ""}
            onChange={event => onEdit({ coefficients: index === 0 ? [event.target.value, coefficients[1] ?? ""] : [coefficients[0] ?? "", event.target.value] })} />
        </label>)}
      </div>
      {answer.membership === "not_in_span" ? <div className="space-y-3">
        {checks}
        <SpanNoSolutionProof coordinates={step.coordinates} answer={answer} edit={onEdit} />
      </div> : null}
      <details className="group rounded-tile border border-line p-3">
        <summary className="cursor-pointer text-sm text-text-2">写出过程（可选，写了能看清卡在哪一步）</summary>
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">{(["v", "w", "u"] as const).map((key, index) => <label key={key} className="block text-xs">α·v + β·w = u 中的 {key}
            <input className={`${ui.input} mt-1`} maxLength={1200} value={vectorText(index < 2 ? equation.vectors[index] : equation.target)}
              onChange={event => {
                const values = spanVectorInput(event.target.value);
                onEdit({ equation: index === 0 ? { ...equation, vectors: [values, equation.vectors[1]] } : index === 1 ? { ...equation, vectors: [equation.vectors[0], values] } : { ...equation, target: values } });
              }} />
          </label>)}</div>
          {answer.membership === "not_in_span" ? null : checks}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs">方程组的解
              <select className={`${ui.input} mt-1`} value={answer.representations?.system ?? ""} onChange={event => onEdit({ representations: { ...answer.representations, system: event.target.value as "unique" | "infinite" | "none" } })}>
                <option value="" disabled>我来判断</option><option value="unique">唯一解</option><option value="infinite">无穷多解</option><option value="none">无解</option>
              </select>
            </label>
            <label className="block text-xs">所有组合构成的几何集合
              <select className={`${ui.input} mt-1`} value={answer.representations?.geometry ?? ""} onChange={event => onEdit({ representations: { ...answer.representations, geometry: event.target.value as "plane" | "line" | "point" } })}>
                <option value="" disabled>我来判断</option><option value="plane">平面</option><option value="line">直线</option><option value="point">一个点</option>
              </select>
            </label>
          </div>
          <MathInput label="我的理由" value={answer.explanation ?? ""} maxLength={6000} disabled={locked} onChange={value => onEdit({ explanation: value })} />
        </div>
      </details>
    </fieldset>
    {photo ? <PhotoField photo={photo} locked={locked} onChoose={onChoosePhoto} onRemove={onRemovePhoto} /> : null}
  </div>;
}

function PhotoField({ photo, locked, onChoose, onRemove }: { photo: PhotoState; locked: boolean; onChoose: (file: File) => void; onRemove: () => void }) {
  const busy = photo.status === "uploading" || photo.status === "preparing";
  const tone = photo.status === "failed" ? "text-danger" : photo.status === "ready" ? "text-text-2" : "text-warn";
  return <section className="space-y-2" aria-label="拍照作答">
    {photo.status === "none"
      ? <label className={`${ui.quiet} cursor-pointer`}>拍照附上过程
        <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={locked}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onChoose(file); }} />
      </label>
      : <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="truncate">{photo.name ?? "作答照片"}</span>
        <span role="status" className={`text-xs ${tone}`}>{busy ? "正在准备照片…" : photo.status === "ready" ? "照片已附上，会随答案一起提交" : photo.message}</span>
        <button type="button" className={ui.quiet} disabled={locked || busy} onClick={onRemove}>移除</button>
      </div>}
  </section>;
}

/** One renderer per step kind. A new kind adds an entry here; the shell does not change. */
export const stepRenderers: { [K in StudyStepKind]: ComponentType<StepRendererProps<Extract<StudyStep, { kind: K }>>> } = {
  learn: LearnRenderer,
  question: SpanQuestionRenderer,
  photo_practice: ({ step, content }) => <div className="space-y-4">
    <div className="prose-reading text-lg leading-8"><LearningProse text={step.prompt} /></div>
    {content}
  </div>,
  card: CardRenderer,
};

export function StepRenderer(props: StepRendererProps) {
  const Renderer = stepRenderers[props.step.kind] as ComponentType<StepRendererProps>;
  return <Renderer {...props} />;
}
