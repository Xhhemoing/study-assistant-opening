"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MaterialWorkbench } from "./material-workbench";
import { MaterialSourceReviewPanel, type MaterialSourceReviewPanelProps } from "./material-source-review-panel";

/** Private author metadata, never a first-answer DTO. The host owns authorization and
 * safe delivery; mounting this component or supplying bindings proves neither. */
export type MaterialAuthorReviewSurfaceProps = {
  input: MaterialSourceReviewPanelProps["input"];
  providedSources?: unknown;
};

/** One raw-input capture feeds both frozen components. Each retains its own validation;
 * no independent candidate, topic projection, purpose/auth flag or network input. */
export function MaterialAuthorReviewSurface({ input, providedSources }: MaterialAuthorReviewSurfaceProps) {
  const snapshot = useMemo(() => {
    try { return input == null ? null : structuredClone(input); }
    catch { return null; }
  }, [input]);
  const [capture, setCapture] = useState({ input, revision: 0 });
  if (capture.input !== input) setCapture({ input, revision: capture.revision + 1 });
  if (!snapshot) return <section aria-label="资料作者审阅" className="rounded-xl border border-border p-4">
    <p role="alert">资料作者审阅暂不可用，请提供当前有效资料。</p>
  </section>;
  return <ReviewSession key={capture.revision} input={snapshot} providedSources={providedSources} />;
}

const views = [{ id: "workbench", label: "资料与技能" }, { id: "sources", label: "来源核对" }] as const;
type View = typeof views[number]["id"];

function ReviewSession({ input, providedSources }: MaterialAuthorReviewSurfaceProps) {
  const id = useId();
  const [view, setView] = useState<View>("workbench");
  const buttons = useRef(new Map<View, HTMLButtonElement>());
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1
      : event.key === "ArrowRight" ? (index + 1) % views.length
        : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : null;
    if (next === null) return;
    event.preventDefault();
    const target = views[next]!.id;
    setView(target); buttons.current.get(target)?.focus();
  }
  return <section aria-label="资料作者审阅" className="space-y-6 text-foreground">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold">资料作者审阅 · 私有只读</h1>
      <p className="text-sm">仅供资料作者审阅／答后核对，不是首答界面；传入用途不代表授权或已验证作答。</p>
      <p className="text-sm">来源页可能含答案或提示。首答前查看须由正式 host 作答流程计为帮助（help）；本组件尚未实现帮助或接触记录，不提供无帮助首答证明。</p>
      <p className="text-sm text-muted-foreground">仅元数据，不生成题干或答案，不授予诊断、评分或 BKT 使用条件。PDF 字节、访问权限与绑定真实性须由 host 确认。</p>
      <p className="text-sm text-muted-foreground">视图切换保留本地选择；替换当前资料或重新挂载后重置。仅更新 host 来源绑定不重置选择；不保存学习记录。</p>
    </header>
    <div role="tablist" aria-label="资料作者审阅视图" className="flex flex-wrap gap-2">
      {views.map((item, index) => <button key={item.id} type="button" role="tab"
        ref={node => { if (node) buttons.current.set(item.id, node); else buttons.current.delete(item.id); }}
        id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`} aria-selected={view === item.id}
        tabIndex={view === item.id ? 0 : -1} onClick={() => setView(item.id)} onKeyDown={event => navigate(event, index)}
        className={`rounded-lg border border-border px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === item.id ? "bg-muted font-semibold" : ""}`}>
        {item.label}
      </button>)}
    </div>
    {views.map(item => <section key={item.id} role="tabpanel" id={`${id}-panel-${item.id}`}
      aria-labelledby={`${id}-tab-${item.id}`} hidden={view !== item.id} tabIndex={0}
      className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {item.id === "workbench" ? <MaterialWorkbench input={input} />
        : <MaterialSourceReviewPanel input={input} providedSources={providedSources} purpose="review" />}
    </section>)}
  </section>;
}
