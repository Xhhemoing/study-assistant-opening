"use client";

import { activeConversation, type PreviewState } from "./model";
import { allMaterials } from "./material-actions";
import { STATUS_LABEL, statusClass } from "./icons";

export function MaterialsPanel(props: {
  state: PreviewState;
  onSelect: (id: string | null) => void;
  onPage: (page: string) => void;
}) {
  const current = activeConversation(props.state);
  const materials = allMaterials(props.state);
  return (
    <aside className="mt-4 border-t border-zinc-200 pt-3 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-4">
      <h2 className="text-sm font-semibold">材料</h2>
      {materials.length === 0 ? <p className="mt-2 text-sm text-zinc-600">这个状态下没有示例材料。</p> : (
        <ul className="mt-2 space-y-2">
          {materials.map((item) => {
            const selected = current?.materialId === item.id;
            const ready = item.status === "ready";
            return (
              <li key={item.id}>
                <button aria-pressed={selected} className="min-h-11 w-full rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed" disabled={!ready} onClick={() => props.onSelect(selected ? null : item.id)} type="button">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs ring-1 ${statusClass(item.status)}`}>{STATUS_LABEL[item.status]}{ready ? "" : " · 暂不可选"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label className="mt-3 block text-xs font-medium text-zinc-600" htmlFor="page-no">页码</label>
      <input className="mt-1 min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:bg-zinc-100" disabled={!current?.materialId} id="page-no" inputMode="numeric" onChange={(event) => props.onPage(event.target.value)} value={current?.page ?? ""} />
    </aside>
  );
}
