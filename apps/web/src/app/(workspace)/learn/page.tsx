import { ArrowRight, CalendarCheck } from "lucide-react";

export default function LearnPage() {
  return (
    <div className="workspace-page">
      <header className="workspace-page__header">
        <p className="workspace-page__eyebrow">目标学习</p>
        <h1>今天，从一个清晰的任务开始</h1>
        <p className="workspace-page__intro">
          计划会根据目标和学习记录逐步形成。在有足够证据前，我们不会给出虚假的掌握判断。
        </p>
      </header>

      <div className="workspace-grid">
        <section className="workspace-section workspace-section--wide">
          <div className="workspace-section__heading">
            <h2>今日任务</h2>
            <CalendarCheck aria-hidden="true" size={19} />
          </div>
          <div className="empty-state">
            <strong>还没有今日任务</strong>
            <p>建立一个学习目标，或先从自由探索开始。你的笔记和练习会逐步形成可执行计划。</p>
            <a className="button" href="/explore">
              开始探索 <ArrowRight aria-hidden="true" size={17} />
            </a>
          </div>
        </section>

        <section className="workspace-section">
          <div className="workspace-section__heading"><h2>总体进度</h2></div>
          <div className="empty-state">
            <strong>未测</strong>
            <p>完成第一个学习活动后，这里会显示简明进度。</p>
          </div>
        </section>

        <section className="workspace-section">
          <div className="workspace-section__heading"><h2>需要关注</h2></div>
          <div className="empty-state">
            <strong>暂无风险点</strong>
            <p>系统只会在有充分学习证据后标记需要关注的内容。</p>
          </div>
        </section>
      </div>
    </div>
  );
}