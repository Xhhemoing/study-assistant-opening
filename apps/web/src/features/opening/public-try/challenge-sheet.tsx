"use client";

import { useEffect, useRef, useState } from "react";
import { challenges, gradeTry, readTryReceipt, storageKey, type TryChallenge, type TryReceipt } from "./challenges";
import { useChallengeClock } from "./challenge-clock";

type Entry = "/login" | "/register";
const buttonClass = "min-h-11 rounded-ctl px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-focus-ring";
const primary = buttonClass + " bg-ink text-on-ink hover:opacity-90 disabled:opacity-45";
const secondary = buttonClass + " border border-line-strong bg-surface hover:bg-surface-2";

export function ChallengeSheet({ entry }: { entry: Entry }) {
  const [question, setQuestion] = useState<TryChallenge>(challenges[0]);
  const [previous, setPrevious] = useState<TryReceipt | null>(null);
  const [attempt, setAttempt] = useState({ number: 0, focusStart: false });

  useEffect(() => {
    try {
      const saved = readTryReceipt(window.sessionStorage.getItem(storageKey));
      if (saved) {
        setQuestion(challenges.find(item => item.id === saved.challenge)!);
        setPrevious(saved);
      }
    } catch { /* Storage can be disabled for this tab. */ }
  }, []);

  function restart(next: TryChallenge, focus: boolean) {
    try { window.sessionStorage.removeItem(storageKey); } catch { /* The new attempt also works in memory. */ }
    setPrevious(null);
    setQuestion(next);
    setAttempt(value => ({ number: value.number + 1, focusStart: focus }));
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-ink sm:px-8 sm:py-14">
      <header className="mb-6 border-b border-line-strong pb-6">
        <h1 className="font-serif text-3xl font-semibold sm:text-4xl">找出推导中的错步</h1>
        <p className="mt-3 text-read-lg text-text-2">选一道题，用 90 秒找出推导里出错的一步，再说说它为什么错。</p>
      </header>
      <label className="mb-4 flex flex-wrap items-center gap-3 text-ui-lg font-medium">
        选择题目
        <select className="min-h-11 rounded-ctl border border-line-strong bg-surface px-3 text-ink focus-visible:outline-focus-ring"
          value={question.id} onChange={event => {
            const next = challenges.find(item => item.id === event.target.value);
            if (next) restart(next, false);
          }}>
          {challenges.map(item => <option key={item.id} value={item.id}>{item.topic}</option>)}
        </select>
      </label>
      <Attempt key={attempt.number} question={question} previous={previous} entry={entry}
        focusStart={attempt.focusStart} restart={() => restart(question, true)} />
    </main>
  );
}

function Choices({ name, title, choices, selected, onSelect, disabled }: {
  name: "step" | "reason"; title: string; choices: readonly string[];
  selected: number | null; onSelect: (value: number) => void; disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="mt-6 min-w-0">
      <legend className="mb-2 text-read font-semibold">{title}</legend>
      <div className="divide-y divide-line rounded-md border border-line">
        {choices.map((text, index) => (
          <label key={text} className="flex min-h-12 items-baseline gap-3 px-3 py-3 has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-focus-ring has-enabled:cursor-pointer has-enabled:hover:bg-surface-2">
            <input type="radio" name={name} value={index} checked={selected === index}
              onChange={() => onSelect(index)} className="shrink-0 accent-accent" />
            <span className="text-read">{name === "step" && <span className="mr-2 whitespace-nowrap font-medium text-text-2">第 {index + 1} 步</span>}{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Attempt({ question, previous, entry, restart, focusStart }: {
  question: TryChallenge; previous: TryReceipt | null; entry: Entry; restart: () => void; focusStart: boolean;
}) {
  const clock = useChallengeClock();
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState<number | null>(null);
  const [reason, setReason] = useState<number | null>(null);
  const [answer, setAnswer] = useState<TryReceipt | null>(null);
  const [stored, setStored] = useState(true);
  const receipt = answer ?? previous;
  const startButton = useRef<HTMLButtonElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const expired = !receipt && clock.seconds === 0;
  useEffect(() => { if (focusStart) startButton.current?.focus(); }, [focusStart]);
  useEffect(() => { if (answer || expired) resultHeading.current?.focus(); }, [answer, expired]);

  function submit() {
    if (!clock.running || step === null || reason === null || !clock.stop()) return;
    const result = { challenge: question.id, step, reason };
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(result)); }
    catch { setStored(false); }
    setAnswer(result);
  }

  return (
    <article className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-8">
      <h2 className="font-serif text-xl font-semibold leading-relaxed sm:text-2xl">{question.question}</h2>
      {!receipt && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-y border-line py-2">
          <span className="text-ui-lg text-text-2">剩余时间</span>
          <span role="timer" aria-label="剩余时间" className="mr-auto font-mono text-xl tabular-nums">
            {Math.floor(clock.seconds / 60).toString().padStart(2, "0")}:{(clock.seconds % 60).toString().padStart(2, "0")}
          </span>
          {!expired && <button className={secondary} ref={startButton} onClick={() => {
            if (clock.running) clock.stop();
            else { setStarted(true); clock.start(); }
          }}>{clock.running ? "暂停" : started ? "继续计时" : "开始计时"}</button>}
          {started && !expired && <button className={buttonClass} onClick={restart}>重新作答</button>}
        </div>
      )}
      <Choices title="哪一步出了错？" name="step" choices={question.steps} selected={receipt?.step ?? step}
        onSelect={setStep} disabled={!clock.running || !!receipt} />
      <Choices title="为什么这一步错了？" name="reason" choices={question.reasons} selected={receipt?.reason ?? reason}
        onSelect={setReason} disabled={!clock.running || !!receipt} />
      {expired ? (
        <section className="mt-6">
          <h3 ref={resultHeading} tabIndex={-1} className="mb-3 font-semibold">时间到了，可以重新作答。</h3>
          <button className={secondary} onClick={restart}>重新作答</button>
        </section>
      ) : receipt ? (
        <section aria-labelledby="try-diagnosis" className="mt-8 border-t border-line-strong pt-6">
          <h3 id="try-diagnosis" tabIndex={-1} ref={resultHeading} className="font-serif text-2xl font-semibold">错因诊断预览</h3>
          <Diagnosis question={question} receipt={receipt} />
          {!stored && <p className="mt-2 text-ui-lg text-text-2">本次诊断仅在当前页面显示。</p>}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <a className={primary} href={entry + "?" + new URLSearchParams({ from: "try", challenge: question.id, step: String(receipt.step) })}>
              {entry === "/login" ? "使用已有账号登录" : "注册并继续学习"}
            </a>
            <button className={secondary} onClick={restart}>重新作答</button>
          </div>
        </section>
      ) : (
        <button className={primary + " mt-6"} disabled={!clock.running || step === null || reason === null} onClick={submit}>核对答案</button>
      )}
    </article>
  );
}

function Diagnosis({ question, receipt }: { question: TryChallenge; receipt: TryReceipt }) {
  const { stepCorrect, reasonCorrect } = gradeTry(question, receipt.step, receipt.reason);
  const verdict = stepCorrect ? (reasonCorrect ? "步骤和原因都找对了。" : "步骤找对了，再看看原因。")
    : (reasonCorrect ? "原因找对了，再看看出错的位置。" : `再看看第 ${question.brokenStep + 1} 步。`);
  return (
    <div className="mt-3 space-y-2 text-read">
      <p className="font-semibold">{verdict}</p>
      <p>第 {question.brokenStep + 1} 步 · {question.reasons[question.correctReason]}</p>
      <p>{question.diagnosis}</p>
      <div className="mt-4 rounded-md bg-surface-2 p-4">
        <h4 className="font-semibold">明日间隔复测预告</h4>
        <p>24 小时后，可以用一道同类题检验自己。{question.retest}</p>
      </div>
    </div>
  );
}
