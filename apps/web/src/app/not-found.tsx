import Link from "next/link";
import { EntryLinks, ui } from "../features/opening/design/ui";

export default function NotFound() {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white px-5 text-center"><p className="text-xs font-medium text-zinc-500">404</p><h1 className="text-xl font-semibold text-zinc-900">没有找到这个页面</h1><p className="text-sm leading-7 text-zinc-500">地址可能已更改，也可以从学习入口继续。</p><Link className={ui.primary} href="/">返回首页</Link><EntryLinks /></main>;
}
