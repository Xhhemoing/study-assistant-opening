import { FilePlus2, Search } from "lucide-react";
import Link from "next/link";
import { LibraryDocumentList } from "../../../features/workspace/library-document-list";

export default function LibraryPage() {
  return (
    <div className="workspace-page">
      <header className="workspace-page__header">
        <p className="workspace-page__eyebrow">笔记与知识库</p>
        <h1>你的长期知识空间</h1>
        <p className="workspace-page__intro">
          笔记保持稳定身份，可以连接多个课程、目标和探索，不会因重新分类产生副本。
        </p>
      </header>

      <section className="workspace-section workspace-section--wide">
        <div className="workspace-section__heading">
          <h2>全部笔记</h2>
          <Link className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/search?q=">
            <Search aria-hidden="true" size={17} /> 搜索
          </Link>
        </div>
        <Link className="button library-new-note" href="/library/new">
          <FilePlus2 aria-hidden="true" size={17} /> 新建笔记
        </Link>
        <LibraryDocumentList />
      </section>
    </div>
  );
}
