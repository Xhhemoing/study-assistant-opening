"use client";

import { useMemo, useState } from "react";
import { formatBarValue, type ComparisonBarsParams } from "../../capabilities/comparison-bars";
import type { RendererProps } from "../artifact-view";

type Order = "original" | "descending";

export function orderBars(bars: ComparisonBarsParams["bars"], order: Order): ComparisonBarsParams["bars"] {
  return order === "descending" ? [...bars].sort((a, b) => b.value - a.value) : bars;
}

/** Bars share one zero baseline; numbers stay visible as text, the bar is decoration. */
export function ComparisonBarsView({ params, mode }: RendererProps<ComparisonBarsParams>) {
  const [order, setOrder] = useState<Order>("original");
  const bars = useMemo(() => orderBars(params.bars, order), [params.bars, order]);
  const max = Math.max(...params.bars.map((bar) => bar.value)) || 1;
  return (
    <figure className="space-y-2">
      <figcaption className="flex items-center justify-between gap-3 text-xs text-zinc-600">
        <span>
          {params.measure}
          {params.unit ? `（${params.unit}）` : "（未声明单位）"}
        </span>
        {mode === "interactive" ? (
          <button
            type="button"
            aria-pressed={order === "descending"}
            onClick={() => setOrder(order === "original" ? "descending" : "original")}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 ring-1 ring-zinc-900/10 transition-colors hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 motion-reduce:transition-none"
          >
            {order === "original" ? "按数值排序" : "恢复原顺序"}
          </button>
        ) : null}
      </figcaption>
      <ul className="space-y-1.5">
        {bars.map((bar) => (
          <li key={bar.label} className="grid grid-cols-[minmax(4rem,8rem)_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate text-zinc-700" title={bar.label}>
              {bar.label}
            </span>
            <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="h-3 w-full" aria-hidden="true">
              <rect x="0" y="0" width="100" height="8" rx="2" className="fill-zinc-100" />
              <rect x="0" y="0" width={(bar.value / max) * 100} height="8" rx="2" className="fill-emerald-600" />
            </svg>
            <span className="tabular-nums text-zinc-900">{formatBarValue(bar.value, params.unit)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
