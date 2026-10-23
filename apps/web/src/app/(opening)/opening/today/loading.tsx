import { LoadingRows } from "../../../../features/opening/design/ui";

export default function TodayLoading() {
  return <section className="mx-auto w-full max-w-[720px] px-4 py-8 sm:px-6" aria-busy="true" aria-labelledby="today-loading-title">
    <h1 id="today-loading-title" className="text-xl font-semibold text-text">开始</h1>
    <LoadingRows label="正在读取学习记录…" />
  </section>;
}
