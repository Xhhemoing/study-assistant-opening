import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ExportMenu } from "../../../../../features/library/export-menu";
import { BackupMenu } from "../../../../../features/library/backup-menu";
import { PageHeading, ui } from "../../../../../features/opening/design/ui";

export default function OpeningExportPage() {
  return <main className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <PageHeading title="数据导出与备份" description="Markdown 和 Anki 是内容投影；本页原生内容备份只覆盖笔记、课程、卡片等库内数据，不包含 Opening 学习记录、材料原件与助理记忆。Opening 备份另按约定范围保存学习数据，暂不包含学习测试记录；学习测试进度恢复需要管理员的完整数据库备份，材料原件还需对象存储备份。" action={<Link className={ui.quiet} href="/opening/library"><ArrowLeft aria-hidden="true" size={14} />返回知识库</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-6 px-5 py-5"><ExportMenu /><BackupMenu /></div></div>
  </main>;
}
