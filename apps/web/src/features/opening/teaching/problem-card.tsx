import type { ReactNode } from "react";
import { LearningProse } from "../assistant/learning-prose";

/** Translation is supplied by the teaching content, never invented by this view. */
export function BilingualProblem({ original, translation, language = "bilingual" }: { original: string; translation?: string; language?: "zh" | "en" | "bilingual" }) {
  return <div className="space-y-3" data-bilingual-problem="true">
    {translation && language !== "en" ? <div lang="zh-CN"><p className="mb-1 text-xs font-medium text-text-2">中文题意</p><LearningProse text={translation} /></div> : null}
    {translation && language === "zh" ? <details className="text-sm"><summary className="min-h-6 cursor-pointer text-text-2">查看英文题干</summary><div lang="en" className="pt-2"><LearningProse text={original} /></div></details>
      : <div {...(translation ? { lang: "en" } : {})}>{translation ? <p className="mb-1 text-xs font-medium text-text-2">英文题干</p> : null}<LearningProse text={original} /></div>}
    {translation && language === "en" ? <details className="text-sm"><summary className="min-h-6 cursor-pointer text-text-2">中文释义</summary><div lang="zh-CN" className="pt-2"><LearningProse text={translation} /></div></details> : null}
  </div>;
}

export function ProblemCard({ prompt, translation, language, children }: { prompt: string; translation?: string; language?: "zh" | "en" | "bilingual"; children?: ReactNode }) {
  return <section className="min-w-0 space-y-4 rounded-card border border-line bg-surface p-4 text-text sm:p-5" aria-label="题目与作答" data-catalog="question">
    <h4 className="font-serif text-xl font-medium leading-7">试一试</h4>
    <BilingualProblem original={prompt} translation={translation} language={language} />
    {children}
  </section>;
}
