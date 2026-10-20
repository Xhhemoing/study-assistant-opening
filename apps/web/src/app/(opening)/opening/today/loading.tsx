import { LoadingRows } from "../../../../features/opening/design/ui";

export default function TodayLoading() {
  return <section className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6" aria-busy="true" aria-labelledby="today-loading-title">
    <h1 id="today-loading-title" className="text-xl font-semibold text-zinc-900">今日学习</h1>
    <p className="mt-2 text-sm leading-6 text-zinc-600">正在读取学习进度与今日安排…</p>
    <LoadingRows label="正在读取今日学习" />
  </section>;
}
