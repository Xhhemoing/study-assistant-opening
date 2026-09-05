import {
  Bot,
  Braces,
  ChevronDown,
  GripVertical,
  Plus,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { CompactControl, LearningModeBanner } from "./notebook-preview-overlays";
import type { NotebookMode } from "./notebook-preview-types";

type DocumentProps = {
  mode: NotebookMode;
  proposalApplied: boolean;
  onExitLearn: () => void;
  onOpenBlocks: () => void;
};

function Block({ children, onOpenBlocks }: { children: ReactNode; onOpenBlocks: () => void }) {
  return (
    <section className="group relative">
      <div className="absolute -left-12 top-0 hidden items-center lg:group-hover:flex">
        <CompactControl label="插入内容块" onClick={onOpenBlocks}><Plus aria-hidden="true" size={15} /></CompactControl>
        <CompactControl label="拖动内容块" onClick={() => undefined}><GripVertical aria-hidden="true" size={15} /></CompactControl>
      </div>
      {children}
    </section>
  );
}

function LearningPrompt() {
  const [showHint, setShowHint] = useState(false);

  return (
    <section className="mt-16 border-y border-white/20 py-8">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-300">回忆提示 · 独立作答</p>
      <h2 className="mt-3 text-2xl font-semibold text-stone-100">先用自己的话回答</h2>
      <p className="mt-3 leading-8 text-stone-300">为什么“检测准确率高”不能直接推出“阳性的人大概率患病”？</p>
      {showHint ? <p className="mt-5 border-l-2 border-sky-300/70 pl-4 text-sm leading-7 text-stone-400">提示：把阳性者拆成两类。除了真正患病者，还要数一数健康人中有多少会误报阳性。</p> : null}
      <button className="mt-6 inline-flex h-9 items-center gap-2 rounded border border-white/15 px-3 text-sm font-medium text-stone-100 hover:bg-white/10" onClick={() => setShowHint((visible) => !visible)} type="button"><Sparkles aria-hidden="true" size={15} />{showHint ? "隐藏提示" : "显示提示"}</button>
    </section>
  );
}

export function NotebookDocument({ mode, proposalApplied, onExitLearn, onOpenBlocks }: DocumentProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <article className="mx-auto max-w-[62rem] px-6 pb-28 pt-14 sm:px-12 sm:pt-20">
      {mode === "learn" ? <LearningModeBanner onExit={onExitLearn} /> : null}
      <header>
        <button aria-label="更换页面图标" className="grid size-12 place-items-center text-3xl text-amber-200 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300" title="更换页面图标" type="button">∑</button>
        <h1 className="mt-6 text-balance text-4xl font-semibold leading-tight text-stone-50 sm:text-5xl">概率推理：从贝叶斯公式到决策</h1>
        <p className="mt-5 max-w-3xl text-xl leading-9 text-stone-400">贝叶斯公式不是替代思考的计算器。它让我们说清楚原先相信什么、证据有多可靠，以及结论要服务于什么行动。</p>
        <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-stone-400"><span className="grid size-5 place-items-center rounded-full bg-amber-200 text-[9px] font-semibold text-stone-900">林</span><span>今天 14:32 编辑</span><span>·</span><span>2 个来源</span><span>·</span><span>v12</span></div>
      </header>

      <div className="mt-14 space-y-12 text-[1.0625rem] leading-8 text-stone-200">
        <Block onOpenBlocks={onOpenBlocks}>
          <h2 className="text-2xl font-semibold leading-8 text-stone-100">贝叶斯公式到底在说什么</h2>
          <p className="mt-5">当观察到证据 <span className="font-mono text-stone-100">E</span> 后，我们用它更新假设 <span className="font-mono text-stone-100">H</span> 的可信程度。关键不在于记住符号，而在于把每个符号对应到可检查的判断。</p>
        </Block>

        <Block onOpenBlocks={onOpenBlocks}>
          <div className="overflow-x-auto border-y border-white/15 py-7 text-center font-serif text-2xl text-stone-100 sm:text-3xl">P(H | E) = <span className="italic">P</span>(E | H) <span className="italic">P</span>(H) / <span className="italic">P</span>(E)</div>
        </Block>

        <Block onOpenBlocks={onOpenBlocks}>
          <section className="border-l-2 border-sky-300/70 pl-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-sky-200"><Braces aria-hidden="true" size={16} />概念：后验概率</div>
            <p className="mt-2 text-[0.95rem] leading-7 text-stone-400">在看见新证据之后，对假设所持有的更新信念。它既不等于证据本身，也不等于检测的准确率。</p>
          </section>
        </Block>

        <Block onOpenBlocks={onOpenBlocks}>
          <section>
            <button aria-expanded={expanded} className="flex w-full items-center gap-2 border-y border-white/15 py-4 text-left text-lg font-semibold text-stone-100 hover:text-sky-200" onClick={() => setExpanded((value) => !value)} type="button"><ChevronDown aria-hidden="true" className={`transition-transform ${expanded ? "" : "-rotate-90"}`} size={18} />从先验到后验</button>
            {expanded ? <div className="pt-5"><p>先验不是主观臆测的同义词。它可以来自历史频率、此前实验、领域约束，或者一个明确标注为不确定的临时假设。</p><p className="mt-4">新证据进入后，后验会成为下一轮推理的先验。因此，可靠的推理记录应保留这条更新链，而不只展示最后的答案。</p></div> : null}
          </section>
        </Block>

        <Block onOpenBlocks={onOpenBlocks}>
          <section>
            <h2 className="text-2xl font-semibold leading-8 text-stone-100">一个诊断测试的例子</h2><p className="mt-4">某疾病患病率为 1%。检测对病人的阳性率是 90%，对健康人的误阳性率是 5%。检测阳性后，患病的概率不是 90%，而是需要把基础患病率一并纳入计算。</p>
            <div className="my-7 grid gap-3 sm:grid-cols-3">{["10000 人中约 100 人患病", "约 90 名病人呈阳性", "约 495 名健康人误报阳性"].map((stat) => <p className="border-l border-white/20 pl-3 text-sm leading-6 text-stone-300" key={stat}>{stat}</p>)}</div>
            <p>所以阳性结果中，真正患病者约占 90 / (90 + 495)，不到六分之一。这个反直觉结果正是忽略先验时容易发生的误判。</p>
          </section>
        </Block>

        {proposalApplied ? <section className="border-l-2 border-violet-300/70 pl-5"><div className="flex items-center gap-2 text-sm font-semibold text-violet-200"><Bot aria-hidden="true" size={16} />已应用的学习版候选</div><ol className="mt-3 list-decimal space-y-1 pl-5 text-[0.95rem] leading-7 text-stone-400"><li>明确假设与先验。</li><li>检查证据的可靠性与独立性。</li><li>计算并解释后验。</li><li>用一个反例检查结论的适用范围。</li></ol></section> : null}
        {mode === "learn" ? <LearningPrompt /> : null}

        {mode === "edit" ? <section className="relative border-t border-white/10 pt-5"><button aria-label="插入内容块" className="flex items-center gap-2 rounded px-1 py-1 text-sm text-stone-400 hover:bg-white/10 hover:text-stone-100" onClick={onOpenBlocks} type="button"><Plus aria-hidden="true" size={16} />输入 / 选择内容块</button></section> : null}
      </div>
    </article>
  );
}
