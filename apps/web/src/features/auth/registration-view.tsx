import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { AuthForm } from "./auth-form";

export function RegistrationView({ registrationClosed }: { registrationClosed: boolean }) {
  return (
    <main className="min-h-dvh bg-bg text-text">
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-10 lg:px-12">
        <header>
          <Link className="inline-flex min-h-11 items-center gap-2.5 rounded-lg text-base font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-4" href="/" aria-label="AIstudy 首页">
            <span className="keycap-ink inline-flex size-9 items-center justify-center rounded-lg text-xs tracking-tight" aria-hidden="true">AI</span>
            AIstudy
          </Link>
        </header>
        <div className="grid items-center gap-10 pt-7 sm:pt-10 lg:grid-cols-[1fr_1.05fr] lg:gap-16 lg:pb-12 lg:pt-12 xl:gap-24">
          <section className="order-last max-w-lg border-t border-line pt-7 lg:order-first lg:border-0 lg:py-8" aria-labelledby="registration-story-title">
            <h2 id="registration-story-title" className="font-serif text-3xl font-semibold leading-snug tracking-tight text-text sm:text-4xl lg:text-5xl lg:leading-[1.18]">
              为好奇，<br className="hidden lg:block" />留一个位置。
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-text-2 lg:mt-6 lg:text-base lg:leading-8">
              从一个问题开始，把探索、笔记和练习连起来。让每次想明白的事，成为自己的积累。
            </p>
            <dl className="mt-10 hidden space-y-6 border-l border-line-strong pl-6 lg:block">
              <div>
                <dt className="text-sm font-medium text-accent">带着问题探索</dt>
                <dd className="mt-1.5 text-sm leading-6 text-text-2">从好奇的地方出发，逐步梳理思路。</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-text">把理解写进笔记</dt>
                <dd className="mt-1.5 text-sm leading-6 text-text-2">留下线索与想法，接着上一次继续。</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-text">用练习巩固所学</dt>
                <dd className="mt-1.5 text-sm leading-6 text-text-2">在回忆和尝试中，找到下一步的方向。</dd>
              </div>
            </dl>
          </section>
          <section className="w-full rounded-panel border border-line bg-surface p-5 shadow-card sm:p-8" aria-labelledby="register-title">
            <header className="mb-6">
              <h1 id="register-title" className="font-serif text-2xl font-semibold tracking-tight text-text">创建你的学习空间</h1>
              <p className="mt-2 text-sm leading-7 text-text-2">用一个账户，留下你的问题、笔记与练习。</p>
            </header>
            <AuthForm mode="register" registrationClosed={registrationClosed} />
            <p className="mt-6 flex flex-wrap items-center gap-x-1 border-t border-line pt-4 text-sm text-text-2">
              已有账户？
              <Link className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 font-medium text-accent underline decoration-accent/35 underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href="/login">
                登录<ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
