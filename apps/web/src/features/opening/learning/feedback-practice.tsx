"use client";
import { useId, useState } from "react";
import type { AiGradingProposal } from "@aistudy/contracts";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";

/** This is instructional feedback; never calls observation or grading APIs. */
export function FeedbackPractice({ question }: { question: NonNullable<AiGradingProposal["followUp"]> }) {
  const name = useId(), [selected, setSelected] = useState(""), [checked, setChecked] = useState(false);
  return <section className="space-y-3 rounded-lg border border-accent/30 p-4" aria-label="再试一小步">
    <h4 className="text-sm font-semibold">再试一小步</h4><LearningProse text={question.prompt} />
    <fieldset disabled={checked} className="space-y-2"><legend className="sr-only">选择答案</legend>{question.options.map(option => <label key={option.id} className="flex min-h-11 items-start gap-2 rounded-lg border border-line p-3 text-sm">
      <input type="radio" name={name} checked={selected === option.id} onChange={() => setSelected(option.id)} className="mt-1 accent-accent" /><span>{option.id}. {option.label}</span>
    </label>)}</fieldset>
    {checked ? <div role="status" className="space-y-2 text-sm"><p className="font-medium">{selected === question.answerId ? "这一步做对了！" : "看看这里的区别"}</p><LearningProse text={question.explanation} />
      {selected !== question.answerId ? <button type="button" className={ui.secondary} onClick={() => { setSelected(""); setChecked(false); }}>再试一次</button> : null}
    </div> : <button type="button" className={ui.secondary} disabled={!selected} onClick={() => setChecked(true)}>检查这一步</button>}
  </section>;
}
