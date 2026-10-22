"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TransitionLink } from "../motion/view-transition";
import { PageHeader } from "../shell/page-header";
import { SETTINGS_PAGES } from "../shell/features";
import { FEATURE_ICONS } from "../shell/icons";

/**
 * T9 设置：子页来自功能注册表（连接、导出、学习测试、高级），新增设置项只需注册。
 * 桌面左侧子导航 + 内容；手机顶部横向滚动。当前项底色带 view-transition-name 滑动。
 */
export function SettingsLayout({ title, tools, children }: { title: string; tools?: ReactNode; children: ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <div data-scroll-root className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <PageHeader title={title} tools={tools} />
      <div className="flex flex-col gap-2 px-2 pb-10 pt-3 md:flex-row md:px-6">
        <nav aria-label="设置分类" className="shrink-0 overflow-x-auto md:sticky md:top-(--topbar-h) md:w-48 md:self-start">
          <ul className="flex gap-1 md:flex-col">
            {SETTINGS_PAGES.map(page => {
              const Icon = FEATURE_ICONS[page.icon];
              const current = pathname === page.route;
              return (
                <li key={page.id}>
                  <TransitionLink href={page.route} direction="swap" aria-current={current ? "page" : undefined}
                    className="relative flex h-(--control-h) items-center gap-2 whitespace-nowrap rounded-pill px-3 text-ui text-text-2 transition-colors hover:text-text aria-[current=page]:font-medium aria-[current=page]:text-text">
                    {current && <span aria-hidden="true" className="absolute inset-0 rounded-pill bg-surface shadow-card [view-transition-name:settings-active]" />}
                    <Icon size={16} aria-hidden="true" className="relative" /><span className="relative">{page.id === "settings" ? "通用" : page.label}</span>
                  </TransitionLink>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1"><div className="content-grid motion-safe:stagger">{children}</div></div>
      </div>
    </div>
  );
}

/** 设置分组：标题 + 行 */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-meta font-medium text-text-2">{title}</h2>
      <div className="divide-y divide-line rounded-tile border border-line bg-surface/80 px-4">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 py-2">
      <div className="min-w-0"><p className="text-ui text-text">{label}</p>{hint ? <p className="text-meta text-text-2">{hint}</p> : null}</div>
      {control}
    </div>
  );
}
