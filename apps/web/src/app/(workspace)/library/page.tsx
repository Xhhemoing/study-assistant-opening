import { FilePlus2, Search } from "lucide-react";
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
          <button className="button button--secondary" type="button" disabled title="全文搜索将在后续任务开放">
            <Search aria-hidden="true" size={17} /> 搜索
          </button>
        </div>
        <button className="button library-new-note" type="button" disabled title="块编辑器将在后续任务开放">
          <FilePlus2 aria-hidden="true" size={17} /> 新建笔记（即将开放）
        </button>
        <LibraryDocumentList />
      </section>
    </div>
  );
}