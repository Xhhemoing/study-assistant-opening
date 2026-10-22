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
    <div className="flex h-full flex-col">
      <PageHeader title={title} tools={tools} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="设置分类" className="shrink-0 overflow-x-auto border-b border-line px-2 py-2 md:w-52 md:border-b-0 md:border-r md:py-4">
          <ul className="flex gap-1 md:flex-col">
            {SETTINGS_PAGES.map(page => {
              const Icon = FEATURE_ICONS[page.icon];
              const current = pathname === page.route;
              return (
                <li key={page.id}>
                  <TransitionLink href={page.route} direction="swap" aria-current={current ? "page" : undefined}
                    className="relative flex min-h-11 items-center gap-2 whitespace-nowrap rounded-md px-3 text-[15px] text-text-2 transition-colors hover:text-text aria-[current=page]:font-medium aria-[current=page]:text-text">
                    {current && <span aria-hidden="true" className="absolute inset-0 rounded-md bg-surface-2 [view-transition-name:settings-active]" />}
                    <Icon size={16} aria-hidden="true" className="relative" /><span className="relative">{page.id === "settings" ? "通用" : page.label}</span>
                  </TransitionLink>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto py-6"><div className="content-grid motion-safe:stagger">{children}</div></div>
      </div>
    </div>
  );
}

/** 设置分组：标题 + 行 */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-[13px] font-medium text-text-2">{title}</h2>
      <div className="divide-y divide-line rounded-card border border-line bg-surface px-4">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-2">
      <div className="min-w-0"><p className="text-[15px] text-text">{label}</p>{hint ? <p className="text-[13px] text-text-2">{hint}</p> : null}</div>
      {control}
    </div>
  );
}
