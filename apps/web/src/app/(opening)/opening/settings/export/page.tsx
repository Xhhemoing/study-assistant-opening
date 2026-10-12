import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ExportMenu } from "../../../../../features/library/export-menu";
import { BackupMenu } from "../../../../../features/library/backup-menu";
import { PageHeading, ui } from "../../../../../features/opening/design/ui";

export default function OpeningExportPage() {
  return <main className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <PageHeading title="数据导出与备份" description="Markdown 和 Anki 是内容投影，原生备份用于完整恢复。" action={<Link className={ui.quiet} href="/opening/library"><ArrowLeft aria-hidden="true" size={14} />返回知识库</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-6 px-5 py-5"><ExportMenu /><BackupMenu /></div></div>
  </main>;
}
