import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ExportMenu } from "../../../../features/library/export-menu";
import { BackupMenu } from "../../../../features/library/backup-menu";
import { PageHeading, ui } from "../../../../features/opening/design/ui";

export default function ExportPage() {
  return <main className="min-w-0 bg-white">
    <PageHeading title="数据导出与备份" description="Markdown 和 Anki 是内容投影，原生备份用于完整恢复。" action={<Link className={ui.quiet} href="/settings"><ArrowLeft aria-hidden="true" size={14} />返回设置</Link>} />
    <div className="mx-auto max-w-4xl space-y-6 px-5 py-5"><ExportMenu /><BackupMenu /></div>
  </main>;
}
