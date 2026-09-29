import Link from "next/link";
import { EmptyState, EntryLinks, PageHeading, ui } from "../opening/design/ui";

export function PlannedPage({ title, description }: { title: string; description: string }) {
  return <section><PageHeading title={title} action={<span className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-500">规划中</span>} />
    <EmptyState title="此功能仍在规划中" description={description} action={<Link className={ui.primary} href="/learn">返回学习空间</Link>} />
    <div className="flex justify-center border-t border-zinc-200 py-4"><EntryLinks /></div>
  </section>;
}
