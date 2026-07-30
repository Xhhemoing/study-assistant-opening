import { ArrowUp, FileText, Lightbulb, Link as LinkIcon } from "lucide-react";

export default function ExplorePage() {
  return (
    <div className="workspace-page">
      <header className="workspace-page__header">
        <p className="workspace-page__eyebrow">自由探索</p>
        <h1>从问题出发</h1>
        <p className="workspace-page__intro">
          不必先创建课程或计划。提出问题、粘贴资料，或从一个还不成熟的想法开始。
        </p>
      </header>

      <section className="workspace-section workspace-section--wide">
        <div className="explore-composer">
          <textarea aria-label="探索内容" placeholder="AI 探索将在后续任务开放" disabled />
          <button className="button" type="button" disabled title="AI 探索将在后续任务开放">
            <ArrowUp aria-hidden="true" size={18} />
            <span>开始</span>
          </button>
        </div>
        <div className="explore-prompts" aria-label="探索起点">
          <button type="button" disabled><Lightbulb aria-hidden="true" size={15} /> 帮我理解一个概念</button>
          <button type="button" disabled><FileText aria-hidden="true" size={15} /> 整理一段资料</button>
          <button type="button" disabled><LinkIcon aria-hidden="true" size={15} /> 分析网页内容</button>
        </div>
      </section>
    </div>
  );
}