"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Columns2, Columns3, Square, X } from "lucide-react";
import { useLayoutPref, type SplitPane } from "../shell/use-layout-pref";
import { Sheet } from "../ui/sheet";
import { ui } from "../ui/controls";

export type SplitPaneSpec = { label: string; icon: ReactNode; render: () => ReactNode };
export type SplitPanes = Partial<Record<SplitPane, SplitPaneSpec>>;

/** 最多两栏：再打开第三栏时替换最早打开的那一栏 */
export const MAX_SPLIT_PANES = 2;
export function toggleSplitPane(current: readonly SplitPane[], pane: SplitPane): SplitPane[] {
  if (current.includes(pane)) return current.filter(item => item !== pane);
  return [...current, pane].slice(-MAX_SPLIT_PANES);
}
/** 只保留本页真的提供的栏，顺序不变 */
export function visibleSplitPanes(current: readonly SplitPane[], panes: SplitPanes): SplitPane[] {
  return current.filter(pane => Boolean(panes[pane])).slice(0, MAX_SPLIT_PANES);
}

const WIDE_QUERY = "(min-width: 1024px)";
function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

/**
 * 学习页右侧分栏：主区 | 栏 1 | 栏 2（最多两栏）。
 * - 桌面（≥1024px）：分隔线可拖动、可用键盘调节（react-resizable-panels 的 ARIA separator），双击恢复默认；
 *   每种栏组合的宽度记在本机。主区始终挂载，开关栏不会重置学习状态。
 * - 窄屏：没有并排空间，点栏名在底部抽屉里打开，一次一个。
 * 分栏控件由调用方放进顶栏：<SplitControls />。
 */
export function SplitView({ panes, children }: { panes: SplitPanes; children: ReactNode }) {
  const [pref, setPref] = useLayoutPref();
  const wide = useWide();
  const active = visibleSplitPanes(pref.split, panes);
  const combo = active.join("+");
  const saved = pref.splitLayouts[combo];
  const [narrowPane, setNarrowPane] = useNarrowPane();

  if (!wide) {
    const spec = narrowPane ? panes[narrowPane] : undefined;
    return <>
      {children}
      <Sheet open={Boolean(spec)} onOpenChange={open => { if (!open) setNarrowPane(null); }} title={spec?.label ?? "分栏"} variant="menu">
        {spec ? <div className="max-h-[70dvh] min-h-[40dvh] overflow-y-auto">{spec.render()}</div> : null}
      </Sheet>
    </>;
  }

  return (
    <Group orientation="horizontal" data-split-group className="h-full min-h-0"
      defaultLayout={saved}
      onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction && combo) setPref({ splitLayouts: { ...pref.splitLayouts, [combo]: layout } }); }}>
      <Panel id="main" minSize="40%" className="min-w-0">{children}</Panel>
      {active.map(pane => {
        const spec = panes[pane]!;
        return [
          <Separator key={`${pane}-separator`} data-split-separator aria-label={`调整「${spec.label}」栏宽度`}
            className="group relative w-2 shrink-0 outline-none">
            <span aria-hidden="true" className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-pill bg-line transition-colors duration-(--duration-micro) group-hover:bg-line-strong group-focus-visible:w-0.5 group-focus-visible:bg-accent group-data-[separator=active]:bg-accent" />
          </Separator>,
          <Panel key={pane} id={pane} minSize="260px" defaultSize="30%" className="min-w-0 py-2 pr-2">
            <section aria-label={spec.label} className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel glass [--glass-bg:var(--glass-bg-strong)] motion-safe:animate-column-in">
              <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-3">
                <span className="text-text-2" aria-hidden="true">{spec.icon}</span>
                <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-text">{spec.label}</h2>
                <button type="button" className={ui.iconSm} aria-label={`关闭「${spec.label}」栏`} onClick={() => setPref({ split: active.filter(item => item !== pane) })}><X size={15} aria-hidden="true" /></button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">{spec.render()}</div>
            </section>
          </Panel>,
        ];
      })}
    </Group>
  );
}

/** 窄屏抽屉里当前打开的栏：模块级共享，顶栏按钮与 SplitView 读写同一个值 */
let narrowValue: SplitPane | null = null;
const narrowListeners = new Set<(value: SplitPane | null) => void>();
function useNarrowPane() {
  const [value, setValue] = useState<SplitPane | null>(narrowValue);
  useEffect(() => { narrowListeners.add(setValue); return () => { narrowListeners.delete(setValue); }; }, []);
  const set = (next: SplitPane | null) => { narrowValue = next; narrowListeners.forEach(listener => listener(next)); };
  return [value, set] as const;
}

/**
 * 顶栏里的分栏控件：三个预设（专注 / 阅读+对话 / 三栏）+ 每个栏的开关。
 * 窄屏只显示栏的开关，点了在底部抽屉打开。
 */
export function SplitControls({ panes }: { panes: SplitPanes }) {
  const [pref, setPref] = useLayoutPref();
  const wide = useWide();
  const [, setNarrowPane] = useNarrowPane();
  const active = visibleSplitPanes(pref.split, panes);
  const available = (Object.keys(panes) as SplitPane[]).filter(pane => panes[pane]);
  if (!available.length) return null;
  const presets: { label: string; icon: ReactNode; split: SplitPane[] }[] = [
    { label: "只看内容", icon: <Square size={14} aria-hidden="true" />, split: [] },
    ...(panes.assistant ? [{ label: "内容 + 对话", icon: <Columns2 size={14} aria-hidden="true" />, split: ["assistant"] as SplitPane[] }] : []),
    ...(available.length > 1 ? [{ label: "三栏", icon: <Columns3 size={14} aria-hidden="true" />, split: (panes.assistant ? ["assistant", available.find(pane => pane !== "assistant")!] : available.slice(0, 2)) as SplitPane[] }] : []),
  ];
  const same = (a: readonly SplitPane[], b: readonly SplitPane[]) => a.length === b.length && a.every((item, index) => item === b[index]);
  return (
    <div role="group" aria-label="分栏" className="flex items-center gap-0.5">
      {wide ? presets.map(preset => (
        <button key={preset.label} type="button" className={ui.iconSm} aria-label={preset.label} title={preset.label}
          aria-pressed={same(active, preset.split)} onClick={() => setPref({ split: preset.split })}>{preset.icon}</button>
      )) : null}
      {wide ? <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" /> : null}
      {available.map(pane => {
        const spec = panes[pane]!;
        return <button key={pane} type="button" className={ui.toolbarButton} aria-pressed={wide ? active.includes(pane) : undefined}
          onClick={() => wide ? setPref({ split: toggleSplitPane(active, pane) }) : setNarrowPane(pane)}>
          {spec.icon}<span className="hidden xl:inline">{spec.label}</span><span className="sr-only xl:hidden">{spec.label}</span>
        </button>;
      })}
    </div>
  );
}
