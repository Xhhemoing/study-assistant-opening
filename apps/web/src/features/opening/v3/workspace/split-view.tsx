"use client";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels";
import { PanelsTopLeft, X } from "lucide-react";
import { useLayoutPref, type SplitPane } from "../shell/use-layout-pref";
import { ui } from "../ui/controls";

export type SplitPaneSpec = { label: string; icon: ReactNode; render: () => ReactNode };
export type SplitPanes = Partial<Record<SplitPane, SplitPaneSpec>>;

/** A single auxiliary surface; legacy multi-pane preferences show the most recent available pane. */
export const MAX_SPLIT_PANES = 1;
export function toggleSplitPane(current: readonly SplitPane[], pane: SplitPane): SplitPane[] {
  return current.includes(pane) ? current.filter(item => item !== pane).slice(-MAX_SPLIT_PANES) : [pane];
}
export function visibleSplitPanes(current: readonly SplitPane[], panes: SplitPanes): SplitPane[] {
  return current.filter(pane => Boolean(panes[pane])).slice(-MAX_SPLIT_PANES);
}

const LAST_PANE_KEY = "aistudy.split.last-pane";
let lastPane: SplitPane | null = null;
function rememberPane(pane: SplitPane) {
  lastPane = pane;
  try { window.localStorage.setItem(LAST_PANE_KEY, pane); } catch { /* This session still remembers the choice. */ }
}
function availablePanes(panes: SplitPanes) { return (Object.keys(panes) as SplitPane[]).filter(pane => panes[pane]); }
function previousPane(panes: SplitPanes): SplitPane | undefined {
  let saved: string | null = lastPane;
  try { saved = window.localStorage.getItem(LAST_PANE_KEY); } catch { /* Use this session's choice. */ }
  return availablePanes(panes).find(pane => pane === saved) ?? availablePanes(panes)[0];
}
const WIDE_QUERY = "(min-width: 1024px)";
function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(query.matches);
    sync(); query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

/** One stable main/editor tree: resizable on desktop, content/tool switching on narrow screens. */
export function SplitView({ panes, children, suspended = false, restoring = false, onSuspendedPaneAvailable, onRestoreClose }: {
  panes: SplitPanes; children: ReactNode; suspended?: boolean; restoring?: boolean;
  onSuspendedPaneAvailable?: (available: boolean) => void;
  onRestoreClose?: () => void;
}) {
  const [pref, setPref] = useLayoutPref();
  const wide = useWide();
  const visited = useRef(new Set<SplitPane>());
  const previousPane = useRef<SplitPane | undefined>(undefined);
  const wasSuspended = useRef(false);
  const capturedPane = useRef<SplitPane | undefined>(undefined);
  const requested = visibleSplitPanes(pref.split, panes)[0];
  if (suspended && !wasSuspended.current) capturedPane.current = previousPane.current;
  if (!suspended) { capturedPane.current = undefined; previousPane.current = requested; }
  wasSuspended.current = suspended;
  const restorable = capturedPane.current && panes[capturedPane.current] && visited.current.has(capturedPane.current) ? capturedPane.current : undefined;
  const selected = suspended ? restoring ? restorable : undefined : requested;
  const restoreMode = Boolean(suspended && restoring);
  const fullWidth = Boolean(selected && (!wide || restoreMode));
  const available = availablePanes(panes);
  const tabs = restoreMode ? restorable ? [restorable] : [] : available;
  const saved = selected ? pref.splitLayouts[selected] : undefined;
  const desiredWidth = selected ? saved?.[selected] ?? 30 : 0;
  const toolPanel = useRef<PanelImperativeHandle | null>(null);
  const surface = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const id = useId();
  if (selected) visited.current.add(selected);
  const close = useCallback(() => {
    if (suspended) { if (restoring) onRestoreClose?.(); }
    else setPref({ split: [] });
  }, [suspended, restoring, onRestoreClose, setPref]);

  useEffect(() => { onSuspendedPaneAvailable?.(Boolean(suspended && restorable)); }, [suspended, restorable, onSuspendedPaneAvailable]);
  useEffect(() => { if (selected && !suspended) rememberPane(selected); }, [selected, suspended]);
  useEffect(() => {
    if (!selected) toolPanel.current?.collapse();
    else toolPanel.current?.resize(fullWidth ? "100%" : `${desiredWidth}%`);
  }, [selected, fullWidth, desiredWidth]);
  useEffect(() => {
    if (selected) {
      if (!wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (fullWidth) surface.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    } else if (wasOpen.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    wasOpen.current = Boolean(selected);
  }, [selected, fullWidth]);
  useEffect(() => {
    if (!selected) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || surface.current?.closest("[hidden],[inert]")) return;
      if ([...document.querySelectorAll('dialog[open],[role="dialog"][data-state="open"]')].some(element => !element.closest("[hidden],[inert]"))) return;
      event.preventDefault(); close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected, close]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (suspended || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const next = event.key === "ArrowRight" ? (index + 1) % available.length : event.key === "ArrowLeft" ? (index + available.length - 1) % available.length : event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setPref({ split: [available[next]!] });
    document.getElementById(`${id}-tab-${available[next]}`)?.focus({ preventScroll: true });
  }

  return <Group orientation="horizontal" data-split-group className="h-full min-h-0"
    onLayoutChanged={(layout, meta) => {
      if (wide && selected && !suspended && meta.isUserInteraction) setPref({ splitLayouts: { ...pref.splitLayouts, [selected]: { main: layout.main!, [selected]: layout.tools! } } });
    }}>
    <Panel key="main" id="main" minSize={wide && !restoreMode ? "40%" : "0%"} className="min-w-0">
      <div hidden={fullWidth} inert={fullWidth} className={fullWidth ? "hidden" : "h-full min-h-0"}>{children}</div>
    </Panel>
    {wide && selected && !restoreMode ? <Separator key="separator" data-split-separator aria-label={`调整「${panes[selected]!.label}」栏宽度`} className="group relative w-2 shrink-0 outline-none">
      <span aria-hidden="true" className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-pill bg-line transition-colors duration-(--duration-micro) group-hover:bg-line-strong group-focus-visible:w-0.5 group-focus-visible:bg-accent group-data-[separator=active]:bg-accent" />
    </Separator> : null}
    <Panel key="tools" id="tools" panelRef={toolPanel} collapsible collapsedSize="0%" minSize={selected && wide ? "260px" : "0%"} maxSize={selected ? fullWidth ? "100%" : "60%" : "0%"} defaultSize="0%" className="min-w-0">
      <section ref={surface} hidden={!selected} aria-label="学习工具" className={selected ? "flex h-full min-h-0 flex-col overflow-hidden rounded-panel bg-surface p-2" : "hidden"}>
        <header className="flex min-h-11 shrink-0 items-center gap-1">
          <div role="tablist" aria-label="学习工具" className="flex min-w-0 flex-1 flex-wrap gap-1">
            {tabs.map((pane, index) => <button key={pane} id={`${id}-tab-${pane}`} role="tab" type="button" aria-selected={selected === pane} aria-controls={`${id}-panel-${pane}`} tabIndex={selected === pane ? 0 : -1} className={ui.toolbarButton} onClick={() => { if (!suspended) setPref({ split: [pane] }); }} onKeyDown={event => navigate(event, index)}>{panes[pane]!.label}</button>)}
          </div>
          <button type="button" className={ui.iconSm} aria-label="关闭学习工具" onClick={close}><X size={15} aria-hidden="true" /></button>
        </header>
        {available.map(pane => <div key={pane} id={`${id}-panel-${pane}`} role="tabpanel" aria-labelledby={`${id}-tab-${pane}`} hidden={selected !== pane} tabIndex={0} className={selected === pane ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}>{visited.current.has(pane) ? panes[pane]!.render() : null}</div>)}
      </section>
    </Panel>
  </Group>;
}

/** A single entry toggles the last available tool; the layout preference remains the source of visibility. */
export function SplitControls({ panes }: { panes: SplitPanes }) {
  const [pref, setPref] = useLayoutPref();
  const selected = visibleSplitPanes(pref.split, panes)[0];
  if (!availablePanes(panes).length) return null;
  return <button type="button" className={ui.toolbarButton} aria-expanded={Boolean(selected)} onClick={() => {
    const next = selected ? null : previousPane(panes);
    if (next) rememberPane(next);
    setPref({ split: next ? [next] : [] });
  }}><PanelsTopLeft size={16} aria-hidden="true" /><span>工具</span></button>;
}
