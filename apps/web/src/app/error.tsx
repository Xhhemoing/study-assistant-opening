"use client";

import Link from "next/link";
import { ui } from "../features/opening/design/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="flex min-h-[60vh] flex-col items-center justify-center gap-4 bg-white px-5 text-center" role="alert"><h1 className="text-lg font-semibold text-zinc-900">暂时无法打开这个页面</h1><p className="text-sm leading-7 text-zinc-500">可以重新尝试，或返回首页继续。</p><div className="flex gap-2"><button type="button" className={ui.primary} onClick={reset}>重新尝试</button><Link className={ui.secondary} href="/">返回首页</Link></div></section>;
}
