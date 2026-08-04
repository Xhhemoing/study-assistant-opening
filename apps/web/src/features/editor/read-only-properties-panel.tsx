"use client";

import { Braces, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReadOnlyProperty } from "@aistudy/contracts";
import { createDocumentPropertiesApi } from "./document-properties-api";

type PropertyState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; document: ReadOnlyProperty[]; blocks: Array<{ blockId: string; blockType: string; text: string | null; properties: ReadOnlyProperty[] }> };

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const result = JSON.stringify(value);
    return result ?? "不可显示";
  } catch {
    return "不可显示";
  }
}

function PropertyList({ properties }: { properties: ReadOnlyProperty[] }) {
  return <dl className="grid gap-2">{properties.map((property) => <div className="grid gap-1 border-t border-line pt-2 first:border-t-0 first:pt-0" key={property.id}><dt className="text-xs font-medium text-text-dim">{property.key}</dt><dd className="break-words text-sm text-text">{formatValue(property.value)}</dd></div>)}</dl>;
}

export function ReadOnlyPropertiesPanel({ documentId }: { documentId: string }) {
  const api = useMemo(() => createDocumentPropertiesApi(), []);
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<PropertyState>({ status: "loading" });
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    api.get(documentId)
      .then((properties) => {
        if (active) setState({ status: "ready", ...properties });
      })
      .catch(() => {
        if (active) setState({ status: "error", message: "属性暂时无法读取。" });
      });
    return () => { active = false; };
  }, [api, documentId, reloadToken]);

  const empty = state.status === "ready" && state.document.length === 0 && state.blocks.length === 0;

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="document-metadata-title">
      <div className="mb-3 flex items-center gap-2"><Braces aria-hidden="true" className="text-primary" size={16} /><h2 className="text-sm font-semibold text-text" id="document-metadata-title">已保存属性</h2></div>
      {state.status === "loading" ? <p className="text-xs text-text-dim" role="status">正在读取属性...</p> : null}
      {state.status === "error" ? <div className="flex items-center gap-2" role="alert"><p className="text-xs text-danger">{state.message}</p><button aria-label="重试读取属性" className="inline-grid size-8 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={reload} title="重试读取属性" type="button"><RefreshCw aria-hidden="true" size={14} /></button></div> : null}
      {empty ? <p className="text-xs text-text-dim">还没有其他已保存属性</p> : null}
      {state.status === "ready" && state.document.length > 0 ? <div className="mb-4"><p className="mb-2 text-xs font-medium text-text-dim">笔记</p><PropertyList properties={state.document} /></div> : null}
      {state.status === "ready" && state.blocks.length > 0 ? <div className="grid gap-4">{state.blocks.map((block) => <div key={block.blockId}><p className="mb-2 truncate text-xs font-medium text-text-dim">区块 · {block.text || block.blockType}</p><PropertyList properties={block.properties} /></div>)}</div> : null}
    </section>
  );
}
