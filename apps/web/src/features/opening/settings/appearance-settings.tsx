"use client";

import { ui } from "../design/ui";
import { useAppearancePreferences, type AppearancePreferences } from "./appearance-preferences";

export function AppearanceSettings() {
  const { preferences, hydrated, persistenceError, updatePreferences } = useAppearancePreferences();
  const fieldClass = `${ui.input} min-h-11 md:pointer-fine:min-h-11`;

  return <section id="appearance" className="scroll-mt-6 grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="appearance-heading">
    <div>
      <h2 className="text-sm font-medium text-text" id="appearance-heading">外观与阅读</h2>
      <p className="mt-1 text-xs leading-6 text-text-3" id="appearance-description">更改立即生效，仅保存在当前浏览器。学习偏好仍单独保存到学习空间。</p>
    </div>
    <div className="space-y-4" aria-describedby="appearance-description">
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-2 text-sm text-text" htmlFor="appearance-theme">
          <span className="block">主题</span>
          <select id="appearance-theme" className={fieldClass} value={preferences.theme} disabled={!hydrated} onChange={event => updatePreferences({ theme: event.target.value as AppearancePreferences["theme"] })}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label className="space-y-2 text-sm text-text" htmlFor="appearance-reading-font">
          <span className="block">阅读字体</span>
          <select id="appearance-reading-font" className={fieldClass} value={preferences.readingFont} disabled={!hydrated} onChange={event => updatePreferences({ readingFont: event.target.value as AppearancePreferences["readingFont"] })}>
            <option value="serif">宋体</option>
            <option value="sans">黑体</option>
          </select>
        </label>
        <label className="space-y-2 text-sm text-text" htmlFor="appearance-motion">
          <span className="block">动态效果</span>
          <select id="appearance-motion" className={fieldClass} value={preferences.motion} disabled={!hydrated} onChange={event => updatePreferences({ motion: event.target.value as AppearancePreferences["motion"] })}>
            <option value="system">跟随系统</option>
            <option value="reduce">减少</option>
          </select>
        </label>
      </div>
      <p className="rounded-lg bg-surface-2 px-4 py-3 font-reading text-read text-text">阅读预览：先理解一个概念，再用自己的话说清楚。</p>
      {persistenceError ? <p className="text-sm text-warn" role="status">浏览器暂时无法保存外观设置。更改仅在当前页面生效，刷新后可能恢复默认。</p> : null}
    </div>
  </section>;
}

/** Kept separate from appearance so the AI diagnostics page can reuse the existing preference. */
export function DiagnosticsSettings() {
  const { preferences, hydrated, persistenceError, updatePreferences } = useAppearancePreferences();
  return <section aria-label="诊断设置" className="space-y-2">
    <details className="border-t border-line pt-2">
    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-text focus-visible:ring-2 focus-visible:ring-accent">高级设置</summary>
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg text-sm text-text focus-within:ring-2 focus-within:ring-accent">
      <span>诊断模式<span className="mt-1 block text-xs leading-6 text-text-3">出现问题时显示更多排查信息；学习记录与评价保持不变。</span></span>
      <input className="size-6 shrink-0 accent-accent" type="checkbox" checked={preferences.diagnostics} disabled={!hydrated} onChange={event => updatePreferences({ diagnostics: event.target.checked })} />
    </label>
    </details>
    {persistenceError ? <p className="text-sm text-warn" role="status">浏览器暂时无法保存诊断设置。更改仅在当前页面生效。</p> : null}
  </section>;
}
