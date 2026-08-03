import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { SearchHit } from "@aistudy/domain";
import { EmptyState } from "@aistudy/ui";
import { groupSearchHits, searchHitHref } from "./search-results-model";

export function SearchResults({ query, hits }: { query: string; hits: SearchHit[] }) {
  if (!query.trim()) {
    return <EmptyState title="输入关键词开始搜索" description="搜索笔记、探索、卡片、课程和练习。" />;
  }

  const groups = groupSearchHits(hits);
  if (groups.length === 0) {
    return <EmptyState title="没有找到匹配内容" description="换一个关键词，或从更具体的标题开始。" />;
  }

  return (
    <div className="space-y-8" data-search-results="true">
      {groups.map((group) => {
        const headingId = `search-group-${group.type}`;
        return (
          <section key={group.type} aria-labelledby={headingId}>
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2 id={headingId} className="text-sm font-semibold text-text">
                {group.label}
              </h2>
              <span className="text-xs text-text-dim">{group.hits.length} 条</span>
            </div>
            <ul className="divide-y divide-line border-y border-line">
              {group.hits.map((hit) => (
                <li key={`${hit.type}-${hit.id}`}>
                  <Link
                    className="group flex items-start justify-between gap-4 px-3 py-4 transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    href={searchHitHref(hit)}
                  >
                    <span className="min-w-0 space-y-1">
                      <span className="block truncate text-sm font-medium text-text group-hover:text-primary">
                        {hit.title}
                      </span>
                      <span className="block line-clamp-2 text-sm leading-6 text-text-dim">
                        {hit.snippet || "暂无摘要"}
                      </span>
                    </span>
                    <ArrowUpRight aria-hidden="true" className="mt-0.5 shrink-0 text-text-dim group-hover:text-primary" size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
