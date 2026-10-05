import { ArrowRight, Circle, CircleCheck, Clock3, Home, Library, MessageSquare, PanelsTopLeft, Settings } from "lucide-react";
import Link from "next/link";
import { buttonClass, secondaryButtonClass, tone, ui } from "@/features/opening/design/ui";

export default function UIPreviewPage() {
  return <div className="min-h-screen bg-zinc-100/70 font-sans text-sm antialiased">
    {/* Shell Preview */}
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="hidden w-52 shrink-0 flex-col items-stretch bg-white px-3 py-3 md:flex">
        <a className="group/logo mb-5 inline-flex h-10 items-center justify-start gap-2.5 rounded-lg px-1.5 text-sm font-semibold tracking-tight text-zinc-900" href="#">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-[11px] font-bold text-white shadow-md shadow-zinc-900/20 ring-1 ring-white/10 transition-transform duration-300 ease-out-expo group-hover/logo:-rotate-6 group-hover/logo:scale-105">AI</span>
          <span>AIstudy</span>
        </a>
        <nav className="flex flex-col gap-1">
          <Link href="#" className="group/nav flex min-h-9 flex-row items-center justify-start gap-2.5 rounded-lg bg-gradient-to-br from-emerald-50 to-emerald-100/70 px-2.5 py-2 text-xs font-semibold text-emerald-900 shadow-xs ring-1 ring-emerald-600/10 transition-[color,background-color,transform] duration-150 active:scale-95">
            <Home size={18} strokeWidth={2} /><span>今日</span>
          </Link>
          <Link href="#" className="flex min-h-9 flex-row items-center justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-zinc-600 transition-[color,background-color,transform] duration-150 hover:bg-zinc-100 hover:text-zinc-900 active:scale-95">
            <MessageSquare size={18} strokeWidth={1.7} /><span>对话</span>
          </Link>
          <Link href="#" className="flex min-h-9 flex-row items-center justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-zinc-600 transition-[color,background-color,transform] duration-150 hover:bg-zinc-100 hover:text-zinc-900 active:scale-95">
            <Library size={18} strokeWidth={1.7} /><span>知识库</span>
          </Link>
        </nav>
        <div className="mt-auto space-y-1 border-t border-zinc-200/70 pt-3">
          <button type="button" className="flex h-10 w-full items-center justify-start gap-2.5 rounded-lg px-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900">
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-semibold text-emerald-800">我</span>
            <span>我的账户</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white md:my-2 md:mr-2 md:rounded-2xl md:border md:border-zinc-200/80 md:shadow-sm md:shadow-zinc-900/5">
        <div className="flex-1 space-y-8 overflow-y-auto p-8">
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Design System Overview</h2>
            <div className="grid gap-6 md:grid-cols-2">
              {/* Typography */}
              <div className="rounded-lg border border-zinc-200/80 bg-white p-5">
                <h3 className="mb-3 text-sm font-semibold text-zinc-900">Typography Scale</h3>
                <div className="space-y-2">
                  <p className="text-[10px] text-zinc-500">10px · Labels</p>
                  <p className="text-xs text-zinc-600">12px · Secondary</p>
                  <p className="text-[13px] text-zinc-700">13px · Nav/Tabs</p>
                  <p className="text-sm text-zinc-800">14px · Body</p>
                  <p className="text-[15px] text-zinc-900">15px · Content</p>
                  <p className="text-lg font-semibold text-zinc-950">18px · Headings</p>
                  <p className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">24px · Metrics</p>
                </div>
              </div>

              {/* Colors & Tones */}
              <div className="rounded-lg border border-zinc-200/80 bg-white p-5">
                <h3 className="mb-3 text-sm font-semibold text-zinc-900">Tone System</h3>
                <div className="space-y-2">
                  <div className={`${tone.neutral} rounded-lg px-3 py-2 text-xs`}>Neutral</div>
                  <div className={`${tone.success} rounded-lg px-3 py-2 text-xs`}>Success</div>
                  <div className={`${tone.warning} rounded-lg px-3 py-2 text-xs`}>Warning</div>
                  <div className={`${tone.danger} rounded-lg px-3 py-2 text-xs`}>Danger</div>
                </div>
              </div>
            </div>
          </section>

          {/* Buttons */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Button System</h2>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={buttonClass}>Primary Action</button>
              <button type="button" className={secondaryButtonClass}>Secondary</button>
              <button type="button" className={ui.primary}>UI Primary</button>
              <button type="button" className={ui.secondary}>UI Secondary</button>
              <button type="button" className={ui.quiet}>Quiet Action</button>
              <button type="button" className={ui.icon}><Settings size={16} /></button>
            </div>
          </section>

          {/* Today Overview Cards */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Today Overview Metrics</h2>
            <dl className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-white px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5">
                <dt className="text-xs text-zinc-500">计划内已完成</dt>
                <dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">3<span className="ml-1 text-base font-normal text-zinc-400">/ 5</span></dd>
              </div>
              <div className="rounded-lg bg-white px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5">
                <dt className="text-xs text-zinc-500">待做</dt>
                <dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-emerald-700">2<span className="ml-1 text-base font-normal text-zinc-400">项</span></dd>
              </div>
              <div className="rounded-lg bg-white px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5">
                <dt className="text-xs text-zinc-500">待做预计</dt>
                <dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">45<span className="ml-1 text-base font-normal text-zinc-400">分</span></dd>
              </div>
            </dl>
          </section>

          {/* Segment Control */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Segment Control</h2>
            <div className="flex rounded-lg bg-zinc-100 p-0.5">
              <button className="min-h-10 flex-1 rounded-md bg-white px-2 text-xs font-medium text-zinc-900 shadow-sm shadow-zinc-900/10 transition-[color,background-color,box-shadow] duration-200 ease-out-expo md:min-h-8">待办 5</button>
              <button className="min-h-10 flex-1 rounded-md px-2 text-xs font-medium text-zinc-600 transition-[color,background-color,box-shadow] duration-200 ease-out-expo hover:text-zinc-900 md:min-h-8">已完成 3</button>
            </div>
          </section>

          {/* Task Cards */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Task Queue Cards</h2>
            <ul className="space-y-0 overflow-hidden rounded-lg border border-zinc-200/60">
              <li>
                <button type="button" className="group flex min-h-[80px] w-full items-start gap-3 border-l-2 border-emerald-600 bg-gradient-to-r from-emerald-50/80 to-transparent px-4 py-3.5 text-left transition-[color,background-color,border-color,transform] duration-200 ease-out-expo hover:from-emerald-50 active:scale-[0.99]">
                  <Circle size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-[13px] font-medium leading-6 text-zinc-900">深入理解 TypeScript 类型系统</span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <Clock3 size={12} />30 分钟<span>/</span>待安排
                    </span>
                  </span>
                  <ArrowRight size={14} className="mt-1 shrink-0 text-emerald-600 motion-safe:animate-enter" />
                </button>
              </li>
              <li className="border-t border-zinc-200/50">
                <button type="button" className="group flex min-h-[80px] w-full items-start gap-3 border-l-2 border-transparent px-4 py-3.5 text-left transition-[color,background-color,border-color,transform] duration-200 ease-out-expo hover:border-zinc-200 hover:bg-zinc-50 active:scale-[0.99]">
                  <Circle size={16} className="mt-0.5 shrink-0 text-zinc-400 transition-colors duration-200 group-hover:text-zinc-500" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-[13px] font-medium leading-6 text-zinc-900">React 18 Concurrent 特性实践</span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <Clock3 size={12} />25 分钟<span>/</span>14:00–14:25
                    </span>
                  </span>
                </button>
              </li>
              <li className="border-t border-zinc-200/50">
                <button type="button" className="group flex min-h-[80px] w-full items-start gap-3 border-l-2 border-transparent px-4 py-3.5 text-left transition-[color,background-color,border-color,transform] duration-200 ease-out-expo hover:border-zinc-200 hover:bg-zinc-50 active:scale-[0.99]">
                  <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-[13px] font-medium leading-6 text-zinc-900">CSS Grid 布局完全指南</span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <Clock3 size={12} />20 分钟<span>/</span>已完成
                    </span>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          {/* Message List */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Chat Messages</h2>
            <div className="rounded-lg bg-gradient-to-b from-zinc-50/30 to-white p-6">
              <ul className="mx-auto flex w-full max-w-[72ch] flex-col gap-6">
                <li className="ml-12 self-end rounded-xl bg-zinc-900 px-4 py-3 text-white shadow-sm shadow-zinc-900/10">
                  <p className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-400">你</p>
                  <p className="whitespace-pre-wrap text-[15px] leading-7 text-white/95">帮我理解一下 React 的 useEffect 依赖数组是怎么工作的？</p>
                </li>
                <li className="w-full min-w-0 motion-safe:animate-enter">
                  <p className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-500">
                    <span className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-zinc-900 to-zinc-800 text-white shadow-sm">
                      <PanelsTopLeft size={12} />
                    </span>
                    学习助理
                  </p>
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-zinc-800">
                    useEffect 的依赖数组决定了副作用函数何时重新执行。简单来说：数组中的任何值变化时，useEffect 会先清理上一次的副作用（如果有 cleanup 函数），然后重新执行副作用函数。
                  </p>
                </li>
              </ul>
            </div>
          </section>

          {/* Composer */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Message Composer</h2>
            <form className="rounded-lg border border-zinc-200/70 bg-white p-3">
              <div className="overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-sm shadow-zinc-900/5 transition-[border-color,box-shadow] duration-200">
                <textarea className="max-h-40 min-h-20 w-full resize-y border-0 bg-transparent px-4 py-3.5 text-base leading-7 text-zinc-900 outline-none placeholder:text-zinc-400" placeholder="自由交流，或基于已选材料提问…" />
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50/50 px-3 py-2.5">
                  <select className="min-h-10 rounded-lg bg-white px-2.5 text-xs text-zinc-700 shadow-xs ring-1 ring-zinc-900/5 md:min-h-8">
                    <option>帮我讲清楚</option>
                    <option>给我一点提示</option>
                  </select>
                  <button type="submit" className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white shadow-md shadow-zinc-900/20 transition-[background-color,transform,box-shadow] duration-200 ease-out-expo hover:bg-zinc-800 hover:shadow-lg active:scale-95 md:size-9">
                    <ArrowRight size={18} />
                  </button>
                </div>
              </div>
            </form>
          </section>

          {/* Empty State */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-zinc-950">Empty State</h2>
            <div className="mx-auto flex w-full max-w-lg flex-col rounded-lg border border-zinc-200/80 bg-gradient-to-b from-zinc-50/30 to-white p-12">
              <span className="mb-5 inline-flex size-14 items-center justify-center self-start rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-800 text-white shadow-lg shadow-zinc-900/20 ring-1 ring-white/10">
                <PanelsTopLeft size={24} strokeWidth={1.75} />
              </span>
              <h3 className="text-xl font-semibold tracking-tight text-zinc-950">今天，想弄懂什么？</h3>
              <p className="mt-2 text-[15px] leading-7 text-zinc-500">还没有消息。自由交流，或选一份材料一起读。</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>;
}
