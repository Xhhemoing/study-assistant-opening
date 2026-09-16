import { EmptyState } from "../../../../features/opening/shell/empty-state";

export default function OpeningTodayPage() {
  return (
    <section className="space-y-6">
      <header>
        <p className="text-sm font-medium text-indigo-600">今天</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">从真实材料开始</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600">这里会显示你的真实学习任务。当前还没有可展示的数据。</p>
      </header>
      <EmptyState title="今天还没有学习任务" description="上传材料或进入助理提问后，这里会根据已保存的学习记录更新。" />
    </section>
  );
}
