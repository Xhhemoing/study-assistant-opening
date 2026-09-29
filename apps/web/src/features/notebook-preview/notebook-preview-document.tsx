import {
  Bot,
  Braces,
  ChevronDown,
  List,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { LearningModeBanner } from "./notebook-preview-overlays";
import { ui } from "../opening/design/ui";
import type { NotebookMode } from "./notebook-preview-types";

type DocumentProps = {
  mode: NotebookMode;
  proposalApplied: boolean;
  onExitLearn: () => void;
  onOpenBlocks: () => void;
};

function Block({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}

function LearningPrompt() {
  const [showHint, setShowHint] = useState(false);

  return (
    <section className="mt-8 border-y border-zinc-200 py-5">
      <p className="text-xs font-medium text-emerald-700">预设回忆提示</p>
      <h2 className="mt-3 text-lg font-semibold text-zinc-900">试着用自己的话回答</h2>
      <p className="mt-3 leading-7 text-zinc-700">为什么“检测准确率高”不能直接推出“阳性的人大概率患病”？</p>
      {showHint ? <p className="mt-3 border-l border-emerald-300 bg-emerald-50 px-4 py-3 text-sm leading-7 text-zinc-500">提示：把阳性者拆成两类。除了真正患病者，还要数一数健康人中有多少会误报阳性。</p> : null}
      <button className={`${ui.secondary} mt-4`} onClick={() => setShowHint((visible) => !visible)} type="button"><Sparkles aria-hidden="true" size={15} />{showHint ? "隐藏预设提示" : "显示预设提示"}</button>
    </section>
  );
}

export function NotebookDocument({ mode, proposalApplied, onExitLearn, onOpenBlocks }: DocumentProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <article className="mx-auto max-w-[54rem] px-4 pb-12 pt-6 text-sm sm:px-8">
      {mode === "learn" ? <LearningModeBanner onExit={onExitLearn} /> : null}
      <header>
        <h1 className="text-balance text-xl font-semibold leading-snug text-zinc-900">概率推理：从贝叶斯公式到决策</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-500">贝叶斯公式不是替代思考的计算器。它让我们说清楚原先相信什么、证据有多可靠，以及结论要服务于什么行动。</p>
        <p className="mt-3 text-xs text-zinc-500">示例主题：概率论 · 决策。下文数字为教学假设。</p>
      </header>

      <div className="mt-7 space-y-6 text-sm leading-7 text-zinc-800">
        <Block>
          <h2 className="text-base font-semibold leading-7 text-zinc-900">贝叶斯公式到底在说什么</h2>
          <p className="mt-3">当观察到证据 <span className="font-mono text-zinc-900">E</span> 后，我们用它更新假设 <span className="font-mono text-zinc-900">H</span> 的可信程度。关键不在于记住符号，而在于把每个符号对应到可检查的判断。</p>
        </Block>

        <Block>
          <div className="overflow-x-auto border-y border-zinc-200 py-4 text-center font-serif text-lg text-zinc-900 sm:text-xl">P(H | E) = <span className="italic">P</span>(E | H) <span className="italic">P</span>(H) / <span className="italic">P</span>(E)</div>
        </Block>

        <Block>
          <section className="border-l border-emerald-300 bg-emerald-50 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800"><Braces aria-hidden="true" size={16} />概念：后验概率</div>
            <p className="mt-2 text-sm leading-7 text-zinc-500">在看见新证据之后，对假设所持有的更新信念。它既不等于证据本身，也不等于检测的准确率。</p>
          </section>
        </Block>

        <Block>
          <section>
            <button aria-expanded={expanded} className="flex w-full items-center gap-2 border-y border-zinc-200 py-3 text-left text-base font-semibold text-zinc-900 hover:text-emerald-800" onClick={() => setExpanded((value) => !value)} type="button"><ChevronDown aria-hidden="true" className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? "" : "-rotate-90"}`} size={18} />从先验到后验</button>
            {expanded ? <div className="pt-5"><p>先验不是主观臆测的同义词。它可以来自历史频率、此前实验、领域约束，或者一个明确标注为不确定的临时假设。</p><p className="mt-4">新证据进入后，后验会成为下一轮推理的先验。因此，可靠的推理记录应保留这条更新链，而不只展示最后的答案。</p></div> : null}
          </section>
        </Block>

        <Block>
          <section>
            <h2 className="text-base font-semibold leading-7 text-zinc-900">一个诊断测试的例子</h2><p className="mt-4">某疾病患病率为 1%。检测对病人的阳性率是 90%，对健康人的误阳性率是 5%。检测阳性后，患病的概率不是 90%，而是需要把基础患病率一并纳入计算。</p>
            <div className="my-4 grid gap-3 sm:grid-cols-3">{["10000 人中约 100 人患病", "约 90 名病人呈阳性", "约 495 名健康人误报阳性"].map((stat) => <p className="border-l border-zinc-200 pl-3 text-sm leading-6 text-zinc-700" key={stat}>{stat}</p>)}</div>
            <p>所以阳性结果中，真正患病者约占 90 / (90 + 495)，不到六分之一。这个反直觉结果正是忽略先验时容易发生的误判。</p>
          </section>
        </Block>

        {proposalApplied ? <section className="border-y border-zinc-200 py-4"><div className="flex items-center gap-2 text-sm font-semibold text-zinc-700"><Bot aria-hidden="true" size={16} />预先编写的学习版示例</div><ol className="mt-3 list-decimal space-y-1 pl-5 text-sm leading-7 text-zinc-500"><li>明确假设与先验。</li><li>检查证据的可靠性与独立性。</li><li>计算并解释后验。</li><li>用一个反例检查结论的适用范围。</li></ol></section> : null}
        {mode === "learn" ? <LearningPrompt /> : null}

        {mode === "edit" ? <section className="border-t border-zinc-200 pt-4"><button aria-label="浏览内容块示例" className={ui.quiet} onClick={onOpenBlocks} type="button"><List aria-hidden="true" size={14} />浏览内容块示例</button></section> : null}
      </div>
    </article>
  );
}
