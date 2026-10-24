"use client";

import { ArrowLeft, BookOpen, Lightbulb, RotateCcw } from "lucide-react";
import { useReducer, useRef } from "react";
import { demoLessonReducer, initialDemoLessonState } from "./demo-lesson-state";

const actionClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";

export function DemoLesson() {
  const [state, dispatch] = useReducer(demoLessonReducer, initialDemoLessonState);
  const conceptButton = useRef<HTMLButtonElement>(null);
  const answerInput = useRef<HTMLTextAreaElement>(null);

  function returnToMaterial() {
    dispatch({ type: "return" });
    conceptButton.current?.focus({ preventScroll: true });
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6" onKeyDown={event => {
      if (event.key === "Escape" && state.panel !== "none") {
        event.preventDefault();
        returnToMaterial();
      }
    }}>
      <header className="space-y-3">
        <a href="/opening/today" className={actionClass}><ArrowLeft aria-hidden="true" className="size-4" />退出示例，返回学习首页</a>
        <p className="text-sm font-medium text-accent">静态示例 · 不调用模型 · 不消耗 AI 预算</p>
        <h1 className="text-2xl font-semibold text-text">先体验一小段学习</h1>
        <p className="text-sm leading-7 text-text-2">读一段材料 → 问一处概念 → 返回原题 → 自己尝试。内容、提示和反馈均为预先编写，不是 AI 实时生成或批改。</p>
        <p className="text-xs leading-6 text-text-3">草稿只保留在当前页面内存中；刷新、退出或重置后清空。不创建课程或学习记录，不计分、不更新掌握度，示例答案不会带入正式学习。</p>
      </header>

      <article className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-labelledby="demo-material-title">
        <h2 id="demo-material-title" className="flex items-center gap-2 text-lg font-medium"><BookOpen aria-hidden="true" className="size-5" />示例材料：向量能到哪里？</h2>
        <p className="text-xs text-text-3">来源：内置示例材料 · 固定版本 1 · 第 1 段</p>
        <p className="leading-8 text-text-2">把向量看作一个可以伸缩、反向的箭头。一组向量的{" "}
          <button ref={conceptButton} type="button" aria-expanded={state.panel !== "none"} aria-controls="demo-concept-preview" className="rounded px-1 font-medium text-accent underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => dispatch({ type: "preview" })}>张成空间（Span）</button>
          ，就是用这些向量做线性组合能到达的所有位置。例如，只有向量 v = (1, 0) 时，无论怎样缩放，都只能沿水平方向移动。
        </p>
        {state.panel !== "none" ? (
          <section id="demo-concept-preview" aria-label="概念预览" className="space-y-3 rounded-lg border border-line bg-surface-2 p-4">
            <h3 className="font-medium">{state.panel === "concept" ? "张成空间 · 原位概念预览" : "示例主线 → 为什么到不了平面上任意一点？"}</h3>
            <p className="text-xs text-text-3">预先编写的示例解释 · 对应上方固定材料第 1 段</p>
            <p className="text-sm leading-7 text-text-2">{state.panel === "concept"
              ? "线性组合指把向量分别乘上系数再相加；所有这样的结果构成张成空间。这里只有一个水平向量，所以张成空间是一条经过原点的水平直线。"
              : "因为任意实数 a 乘以 (1, 0) 都得到 (a, 0)，纵坐标始终为 0。伸缩或反向不会增加新的方向，因此到不了纵坐标不为 0 的位置。"}</p>
            <div className="flex flex-wrap gap-2">
              {state.panel === "concept" ? <button type="button" className={actionClass} onClick={() => dispatch({ type: "deepen" })}>继续问（固定示例）</button> : null}
              <button type="button" className={actionClass} onClick={returnToMaterial}><ArrowLeft aria-hidden="true" className="size-4" />返回示例主线</button>
            </div>
            <p className="text-xs text-text-3">可按 Esc 返回；原材料和下方草稿保持不变。</p>
          </section>
        ) : null}
      </article>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-labelledby="demo-question-title">
        <h2 id="demo-question-title" className="text-lg font-medium">自己试一题</h2>
        <p className="leading-7 text-text-2">只有 v = (1, 0)，能用它的倍数到达 (0, 1) 吗？用一句话说明原因。</p>
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); dispatch({ type: "submit" }); }}>
          <label htmlFor="demo-answer" className="block text-sm font-medium">我的示例答案</label>
          <textarea ref={answerInput} id="demo-answer" rows={4} maxLength={2000} value={state.draft} onChange={event => dispatch({ type: "edit", text: event.target.value })} className="w-full rounded-lg border border-line bg-bg p-3 text-sm leading-7 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" placeholder="写下你的判断和理由，不需要标准句式。" />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={`${actionClass} bg-ink text-on-ink hover:bg-ink`} disabled={!state.draft.trim() || state.feedbackVisible}>查看示例反馈</button>
            <button type="button" className={actionClass} aria-expanded={state.hintVisible} aria-controls="demo-hint" onClick={() => dispatch({ type: "hint" })}><Lightbulb aria-hidden="true" className="size-4" />看固定提示</button>
          </div>
        </form>
        {state.hintVisible ? <p id="demo-hint" className="rounded-lg bg-surface-2 p-3 text-sm leading-7 text-text-2">固定提示：试着写出 a × (1, 0) 的坐标，看看哪个坐标始终不变。</p> : null}
        {state.feedbackVisible ? (
          <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-4" role="status">
            <h3 className="font-medium">示例反馈（固定内容，不判断你的答案）</h3>
            <p className="text-sm leading-7 text-text-2">对照要点：不能到达。任意倍数都是 (a, 0)，而目标 (0, 1) 的纵坐标是 1。请自行检查，你的解释是否说清了“纵坐标始终为 0”。这里不代表答对、完成课程或已掌握。</p>
            <button type="button" className={actionClass} onClick={() => { dispatch({ type: "revise" }); answerInput.current?.focus({ preventScroll: true }); }}>自己改答</button>
          </div>
        ) : null}
        {state.submittedAnswers.length > 0 ? (
          <details className="text-sm text-text-2">
            <summary className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">查看本页保留的原答与修订（仅示例）</summary>
            <ol className="list-decimal space-y-2 whitespace-pre-wrap break-words pl-5">{state.submittedAnswers.map((answer, index) => <li key={index}>{answer}</li>)}</ol>
          </details>
        ) : null}
      </section>

      <footer className="flex flex-wrap items-center gap-3">
        <button type="button" className={actionClass} onClick={() => { dispatch({ type: "reset" }); conceptButton.current?.focus({ preventScroll: true }); }}><RotateCcw aria-hidden="true" className="size-4" />重置示例</button>
        <a href="/opening/today" className={actionClass}>结束示例，返回学习首页</a>
      </footer>
    </main>
  );
}
