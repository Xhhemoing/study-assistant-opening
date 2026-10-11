import Link from "next/link";
import { buttonClass, EmptyState, secondaryButtonClass, ui } from "../design/ui";
import type { TodayResumeState } from "./today-read";
import type { TeachingActivity } from "@aistudy/contracts";
import { todayActivityCtaLabel } from "../teaching/today-activity";

const primary = `${buttonClass} mt-4`;

export function TodayResumeBody({
  state,
  activity = null,
  onPrimaryCta,
  primaryBusy = false,
}: {
  state: TodayResumeState;
  /** When provided, CTA follows activity continue/start semantics. */
  activity?: TeachingActivity | null;
  onPrimaryCta?: () => void;
  primaryBusy?: boolean;
}) {
  if (state.kind === "loggedOut") {
    return (
      <>
        <EmptyState title="尚未登录" description="登录后即可查看今天的学习记录。" />
        <Link className={primary} href="/login">登录</Link>
      </>
    );
  }
  if (state.kind === "error") {
    return (
      <>
        <EmptyState title="学习记录暂时无法读取" description="读取失败时不会以空状态代替。" />
        <Link href="/opening/today" className={secondaryButtonClass}>重新读取</Link>
      </>
    );
  }
  const item = state.continueItem;
  const ctaLabel = todayActivityCtaLabel(activity ?? null);
  // Without an interactive handler, land on Today dashboard (activity wiring lives there).
  const primaryHref = "/opening/today";
  const assistantHref = item
    ? `/opening/assistant?conversation=${encodeURIComponent(item.conversationId)}`
    : "/opening/assistant";

  return (
    <>
      {item ? (
        <article className="border-b border-zinc-200 bg-white px-5 py-5">
          <h2 className="text-sm font-semibold text-zinc-900">继续：{item.title}</h2>
          {item.lastUserText ? (
            <p className="mt-2 break-words text-sm leading-6 text-zinc-600">{item.lastUserText}</p>
          ) : null}
          <p className="mt-3 text-sm text-zinc-500">
            {item.currentPage ? `上次读到第 ${item.currentPage} 页` : "从上次对话继续"}
            {Object.keys(item.sourceVersions ?? {}).length
              ? ` · 可恢复 ${Object.keys(item.sourceVersions ?? {}).length} 份材料`
              : ""}
          </p>
          {(item.manualSourceCount ?? 0) > 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              {item.manualSourceCount} 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。
            </p>
          ) : null}
          {onPrimaryCta ? (
            <button type="button" className={primary} data-today-primary-cta="true" onClick={onPrimaryCta} disabled={primaryBusy}>
              {primaryBusy ? "处理中…" : ctaLabel}
            </button>
          ) : (
            <Link className={primary} href={primaryHref} data-today-primary-cta="true">
              {ctaLabel}
            </Link>
          )}
          <p className="mt-3">
            <Link href={assistantHref} className={ui.quiet} data-today-assistant-secondary="true">
              打开自由对话（次要）
            </Link>
          </p>
        </article>
      ) : (
        <>
          <EmptyState title="还没有可继续的对话" description="可以向助理提问，或从今日工作台开始一条教学活动。" />
          {onPrimaryCta ? (
            <button type="button" className={primary} data-today-primary-cta="true" onClick={onPrimaryCta} disabled={primaryBusy}>
              {primaryBusy ? "处理中…" : "开始学习"}
            </button>
          ) : (
            <Link className={primary} href={primaryHref} data-today-primary-cta="true">
              开始学习
            </Link>
          )}
          <p className="mt-3 px-5">
            <Link href="/opening/assistant" className={ui.quiet} data-today-assistant-secondary="true">
              向助理提问（次要）
            </Link>
          </p>
        </>
      )}
      {(state.pendingReviews?.count ?? 0) > 0 ? (
        <article className="border-b border-zinc-200 bg-white px-5 py-5">
          <h2 className="text-base font-semibold text-zinc-900">
            {state.pendingReviews!.count} 项建议待审核
          </h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600">
            任务、记忆与补测都由你决定；可以稍后处理，不影响继续学习。
          </p>
          <Link href="/opening/review" className={`${secondaryButtonClass} mt-4`}>
            查看待审核建议
          </Link>
        </article>
      ) : null}
    </>
  );
}
