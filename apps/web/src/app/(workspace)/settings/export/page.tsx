import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ExportMenu } from "../../../../features/library/export-menu";
import { BackupMenu } from "../../../../features/library/backup-menu";

export default function ExportPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-3 border-b border-line pb-6">
        <Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/settings">
          <ArrowLeft aria-hidden="true" size={16} />返回设置
        </Link>
        <div className="space-y-1">
          <p className="text-xs text-text-dim">工作区</p>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">数据导出</h1>
          <p className="text-sm leading-6 text-text-dim">Markdown 和 Anki 只是投影，不是完整备份。需要完整恢复时使用下方的原生备份。</p>
        </div>
      </header>
      <ExportMenu />
      <BackupMenu />
    </main>
  );
}
