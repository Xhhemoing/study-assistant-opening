"use client";
import { useState } from "react";
import { ui } from "../ui/controls";
import { SuccessCheck, useReplay } from "../motion/feedback";

type Choice = { id: string; label: string };

type Props = {
  question: string;
  choices: Choice[];
  correctId: string;
  explanation: string;
  /** 用户作出预测后再执行操作（如把画布动画到目标矩阵） */
  onReveal: () => void;
  /** 记录预测结果（作为一次练习表现，不等于掌握） */
  onResult?: (correct: boolean) => void;
};

/** 先预测 → 操作 → 解释 → 验证。预测错时选项轻微抖动，揭示后给出解释，不直接判「不会」。 */
export function PredictPrompt({ question, choices, correctId, explanation, onReveal, onResult }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const [wrongCount, setWrongCount] = useState(0);
  const shaking = useReplay(wrongCount);
  const revealed = picked !== null;
  const correct = picked === correctId;
  function pick(id: string) {
    if (revealed) return;
    setPicked(id);
    if (id !== correctId) setWrongCount(n => n + 1);
    onReveal();
    onResult?.(id === correctId);
  }
  return (
    <section aria-label="先预测" className="space-y-3 rounded-tile border border-line bg-surface p-4">
      <p className="text-ui text-text">{question}</p>
      <div role="group" aria-label="你的预测" className={`flex flex-wrap gap-2 ${shaking ? "motion-safe:animate-shake" : ""}`}>
        {choices.map(choice => (
          <button key={choice.id} type="button" aria-pressed={picked === choice.id} onClick={() => pick(choice.id)} disabled={revealed && picked !== choice.id}
            className={`${ui.secondary} aria-pressed:border-text aria-pressed:bg-surface-2 ${revealed && choice.id === correctId ? "border-accent text-accent" : ""}`}>{choice.label}</button>
        ))}
      </div>
      {revealed && (
        <div className="flex items-start gap-2 text-ui text-text motion-safe:animate-text-in">
          {correct ? <SuccessCheck play label="预测正确" /> : <span className="text-warn" role="img" aria-label="预测不对">↺</span>}
          <p><span className="font-medium">{correct ? "预测对了。" : "和预测不一样。"}</span>{explanation}</p>
        </div>
      )}
      {revealed && <button type="button" className={`${ui.quiet} -ml-3`} onClick={() => setPicked(null)}>再预测一次</button>}
    </section>
  );
}
