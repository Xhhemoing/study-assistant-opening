import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { SearchHit } from "@aistudy/domain";
import { EmptyState } from "../opening/design/ui";
import { groupSearchHits, searchHitHref } from "./search-results-model";

export function SearchResults({ query, hits }: { query: string; hits: SearchHit[] }) {
  if (!query.trim()) {
    return <EmptyState title="输入关键词开始搜索" description="搜索笔记和课程。" />;
  }

  const groups = groupSearchHits(hits);
  if (groups.length === 0) {
    return <EmptyState title="没有找到匹配内容" description="换一个关键词，或从更具体的标题开始。" />;
  }

  return (
    <div className="space-y-6" data-search-results="true">
      {groups.map((group) => {
        const headingId = `search-group-${group.type}`;
        return (
          <section key={group.type} aria-labelledby={headingId}>
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2 id={headingId} className="text-sm font-semibold text-zinc-900">
                {group.label}
              </h2>
              <span className="text-xs text-zinc-500">{group.hits.length} 条</span>
            </div>
            <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
              {group.hits.map((hit) => (
                <li key={`${hit.type}-${hit.id}`}>
                  <Link
                    className="group flex items-start justify-between gap-4 px-3 py-3 transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-50 focus-visible:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600"
                    href={searchHitHref(hit)}
                  >
                    <span className="min-w-0 space-y-1">
                      <span className="block truncate text-sm font-medium text-zinc-900 group-hover:text-emerald-700">
                        {hit.title}
                      </span>
                      <span className="block line-clamp-2 text-sm leading-7 text-zinc-500">
                        {hit.snippet || "暂无摘要"}
                      </span>
                      {hit.lifecycle || hit.courseMemberships?.length ? (
                        <span className="block text-xs text-zinc-500">
                          {[
                            hit.lifecycle,
                            hit.courseMemberships?.map((course) => course.title).join("、"),
                          ].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </span>
                    <ArrowUpRight aria-hidden="true" className="mt-0.5 shrink-0 text-zinc-500 group-hover:text-emerald-700" size={16} />
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
