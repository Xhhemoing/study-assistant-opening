"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MaterialPackagePreview } from "./material-package-preview";
import { MaterialSkillRouteView } from "./material-skill-route-view";
import { readMaterialWorkbench, type MaterialWorkbenchHostProps } from "./material-workbench-model";

/** Mountable local workbench; no route, storage, learning write or import action. */
export function MaterialWorkbench({ input }: MaterialWorkbenchHostProps) {
  const data = useMemo(() => readMaterialWorkbench(input), [input]);
  if (!data) return <section aria-label="资料工作台" className="rounded-xl border border-border p-4">
    <p role="alert">资料工作台暂不可用，请提供同一次有效的资料内容。</p>
  </section>;
  return <WorkbenchSession data={data} />;
}

type WorkbenchData = NonNullable<ReturnType<typeof readMaterialWorkbench>>;
const tabs = [{ id: "preview", label: "资料预览" }, { id: "route", label: "技能路线" }] as const;
type Tab = typeof tabs[number]["id"];

function WorkbenchSession({ data }: { data: WorkbenchData }) {
  const id = useId();
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());
  const [session, setSession] = useState({ data, tab: "preview" as Tab, revision: 0 });
  // A replacement capture starts a new local session, including the child's filters/focus state.
  if (session.data !== data) setSession({ data, tab: "preview", revision: session.revision + 1 });
  const select = (tab: Tab) => setSession(current => ({ ...current, tab }));
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
    if (target === null) return;
    event.preventDefault();
    const tab = tabs[target]!.id;
    select(tab); buttons.current.get(tab)?.focus();
  }
  return <section aria-label="资料工作台" className="space-y-6 text-foreground">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold">资料工作台 · 候选未发布</h1>
      <p className="text-sm text-muted-foreground">仅查看资料映射与先修路线；全部未测，独立条件未知，不可评分或晋级。</p>
      <p className="text-sm text-muted-foreground">只读审阅，不是首答界面；无题干，尚不可作答。答后备注、技能目标与错因不向首答者展示。</p>
    </header>
    <p className="text-sm text-muted-foreground">筛选与选择仅在当前页保留；切换面板、替换资料或重新挂载后重置，不保存学习记录。</p>
    <div role="tablist" aria-label="资料工作台视图" className="flex gap-2">
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab"
        ref={node => { if (node) buttons.current.set(tab.id, node); else buttons.current.delete(tab.id); }}
        id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`} aria-selected={session.tab === tab.id}
        tabIndex={session.tab === tab.id ? 0 : -1} onClick={() => select(tab.id)} onKeyDown={event => navigate(event, index)}
        className={`rounded-lg border border-border px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${session.tab === tab.id ? "bg-muted font-semibold" : ""}`}>
        {tab.label}
      </button>)}
    </div>
    {tabs.map(tab => <section key={tab.id} role="tabpanel" id={`${id}-panel-${tab.id}`}
      aria-labelledby={`${id}-tab-${tab.id}`} hidden={session.tab !== tab.id} tabIndex={0}
      className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {session.tab === tab.id && (tab.id === "preview"
        ? <MaterialPackagePreview candidate={data.candidate} />
        : <MaterialSkillRouteView key={session.revision} data={data.route} />)}
    </section>)}
  </section>;
}
