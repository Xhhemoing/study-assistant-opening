import type { ElementType, ReactNode } from "react";

export function Card({ as: Component = "div", children, className = "" }: { as?: ElementType; children: ReactNode; className?: string }) {
  return <Component className={`rounded-lg border border-line bg-surface p-5 ${className}`}>{children}</Component>;
}
