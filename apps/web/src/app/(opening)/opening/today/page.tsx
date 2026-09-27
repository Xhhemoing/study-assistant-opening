import Link from "next/link";
import { headers } from "next/headers";
import { ApiError } from "../../../../features/auth/service";
import { EmptyState } from "../../../../features/opening/shell/empty-state";
import { todayConfirmHref, type TodayResumeState } from "../../../../features/opening/planning/today-read";
import {
  createTodayResumeReader,
  loadTodayResumeState,
} from "../../../../features/opening/planning/today-service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { TodayPlanView } from "../../../../features/opening/planning/today-view";

export default async function OpeningTodayPage() {
  const loaded = await loadPage();

  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header>
        <p className="text-sm font-medium text-indigo-600">今天</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">从真实材料开始</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          这里只显示已保存的学习记录，不会编造任务。
        </p>
      </header>
      <TodayResumeBody confirmHref={loaded.confirmHref} state={loaded.state} />
      {loaded.state.kind !== "loggedOut" && loaded.state.kind !== "error" ? <TodayPlanView /> : null}
    </section>
  );
}

async function loadPage(): Promise<{ state: TodayResumeState; confirmHref: string }> {
  try {
    const requestHeaders = await headers();
    const request = new Request("http://opening.local/today", { headers: requestHeaders });
    const { scope, sql } = await requireOpeningScope(request);
    const reader = createTodayResumeReader(sql);
    const state = await loadTodayResumeState({ scope, reader });
    const pending = state.kind === "confirm" ? await reader.pendingCandidates(scope) : [];
    return { state, confirmHref: todayConfirmHref(pending) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { state: { kind: "loggedOut" }, confirmHref: "/login" };
    }
    throw error;
  }
}

function TodayResumeBody({
  state,
  confirmHref,
}: {
  state: TodayResumeState;
  confirmHref: string;
}) {
  if (state.kind === "loggedOut") {
    return (
      <>
        <EmptyState
          title="尚未登录"
          description="登录后即可查看今天的学习记录。"
        />
        <p className="text-sm font-medium text-zinc-900">现在可以做什么</p>
        <Link
          className="inline-flex min-h-10 w-fit items-center rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          href="/login"
        >
          登录
        </Link>
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <EmptyState
        title="学习记录暂时无法读取"
        description="请稍后重试。读取失败时不会以空状态代替。"
      />
    );
  }

  if (state.kind === "confirm") {
    return (
      <article className="rounded-xl border border-zinc-200 bg-white p-6">
        <p className="text-sm font-medium text-zinc-500">需要确认</p>
        <h2 className="mt-2 text-lg font-semibold text-zinc-900">
          有 {state.confirmCount ?? 0} 项内容待确认
        </h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          请先处理待确认事项，再开始新的学习。
        </p>
        <p className="mt-6 text-sm font-medium text-zinc-900">现在可以做什么</p>
        <Link
          className="mt-3 inline-flex min-h-10 items-center rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          href={confirmHref}
        >
          去确认
        </Link>
      </article>
    );
  }

  if (state.kind === "continue" && state.continueItem) {
    const item = state.continueItem;
    const href = `/opening/assistant?conversation=${encodeURIComponent(item.conversationId)}`;
    return (
      <article className="rounded-xl border border-zinc-200 bg-white p-6">
        <p className="text-sm font-medium text-zinc-500">上次停在</p>
        <h2 className="mt-2 text-lg font-semibold text-zinc-900">{item.title}</h2>
        {item.lastUserText ? (
          <p className="mt-2 text-sm leading-6 text-zinc-600">{item.lastUserText}</p>
        ) : null}
        <dl className="mt-4 space-y-1 text-sm text-zinc-600">
          <div>courseId {item.courseId ?? "未关联课程"}</div>
          <div>sourceVersions {formatVersions(item.sourceVersions)}</div>
          <div>currentPage {item.currentPage ?? "未记录"}</div>
        </dl>
        <p className="mt-6 text-sm font-medium text-zinc-900">现在可以做什么</p>
        <Link
          className="mt-3 inline-flex min-h-10 items-center rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          href={href}
        >
          继续
        </Link>
      </article>
    );
  }

  return (
    <>
      <EmptyState
        title="还没有学习记录"
        description="上传材料或向助理提问后，这里会根据已保存的学习记录更新。"
      />
      <p className="text-sm font-medium text-zinc-900">现在可以做什么</p>
      <Link
        className="inline-flex min-h-10 w-fit items-center rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        href="/opening/assistant"
      >
        向助理提问
      </Link>
    </>
  );
}

function formatVersions(versions: Record<string, number> | undefined): string {
  const entries = Object.entries(versions ?? {});
  if (!entries.length) return "无材料版本";
  return entries.map(([id, version]) => `${id}:${version}`).join(", ");
}
