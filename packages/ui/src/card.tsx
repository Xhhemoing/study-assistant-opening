import type { ElementType, ReactNode } from "react";

export function Card({ as: Component = "div", children, className = "" }: { as?: ElementType; children: ReactNode; className?: string }) {
  return <Component className={`rounded-md border border-zinc-200 bg-white p-4 ${className}`}>{children}</Component>;
}
