import Link from "next/link";
import { buttonClass, EmptyState, secondaryButtonClass } from "../design/ui";
import type { TodayResumeState } from "./today-read";

const primary = `${buttonClass} mt-4`;
export function TodayResumeBody({ state }: { state: TodayResumeState }) {
  if (state.kind === "loggedOut") return <><EmptyState title="尚未登录" description="登录后即可查看今天的学习记录。" /><Link className={primary} href="/login">登录</Link></>;
  if (state.kind === "error") return <><EmptyState title="学习记录暂时无法读取" description="读取失败时不会以空状态代替。" /><Link href="/opening/today" className={secondaryButtonClass}>重新读取</Link></>;
  const item = state.continueItem;
  return <>
    {item ? <article className="border-b border-zinc-200 bg-white px-5 py-5">
      <h2 className="text-sm font-semibold text-zinc-900">继续：{item.title}</h2>
      {item.lastUserText ? <p className="mt-2 break-words text-sm leading-6 text-zinc-600">{item.lastUserText}</p> : null}
      <p className="mt-3 text-sm text-zinc-500">{item.currentPage ? `上次读到第 ${item.currentPage} 页` : "从上次对话继续"}{Object.keys(item.sourceVersions ?? {}).length ? ` · 可恢复 ${Object.keys(item.sourceVersions ?? {}).length} 份材料` : ""}</p>
      {(item.manualSourceCount ?? 0) > 0 ? <p className="mt-2 text-sm text-zinc-500">{item.manualSourceCount} 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。</p> : null}
      <Link className={primary} href={`/opening/assistant?conversation=${encodeURIComponent(item.conversationId)}`}>继续学习</Link>
    </article> : <><EmptyState title="还没有可继续的对话" description="向助理提问后，可以从这里回到已保存的对话。" /><Link className={primary} href="/opening/assistant">向助理提问</Link></>}
    {(state.pendingReviews?.count ?? 0) > 0 ? <article className="border-b border-zinc-200 bg-white px-5 py-5">
      <h2 className="text-base font-semibold text-zinc-900">{state.pendingReviews!.count} 项建议待审核</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-600">任务、记忆与补测都由你决定；可以稍后处理，不影响继续学习。</p>
      <Link href="/opening/review" className={`${secondaryButtonClass} mt-4`}>查看待审核建议</Link>
    </article> : null}
  </>;
}
