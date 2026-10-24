"use client";

import { TransitionLink as Link } from "../features/opening/v3/motion/view-transition";
import { ErrorState, ui } from "@aistudy/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 bg-bg px-5">
    <h1 className="font-serif text-2xl font-medium text-text">暂时无法打开这个页面</h1>
    <ErrorState message="可以重新尝试，或返回首页继续。" onRetry={reset} retryLabel="重新尝试" />
    <Link className={ui.quiet} href="/">返回首页</Link>
  </main>;
}
