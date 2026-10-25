import { ArrowLeft } from "lucide-react";
import { TransitionLink as Link } from "../../../../../features/opening/v3/motion/view-transition";
import { ExportMenu } from "../../../../../features/library/export-menu";
import { BackupMenu } from "../../../../../features/library/backup-menu";
import { PageHeading, ui } from "../../../../../features/opening/design/ui";

export default function OpeningExportPage() {
  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <PageHeading title="数据导出与备份" description="Markdown 和 Anki 用于在其他工具里查看内容。这里的备份包含笔记、课程和卡片，不包含学习记录、原始资料和助理记忆。" action={<Link className={ui.quiet} href="/opening/library"><ArrowLeft aria-hidden="true" size={14} />返回知识库</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-6 px-5 py-5"><ExportMenu /><BackupMenu /></div></div>
  </section>;
}
