import type { ElementType, ReactNode } from "react";
import { ui } from "./styles";

export function Card({ as: Component = "div", children, className = "" }: { as?: ElementType; children: ReactNode; className?: string }) {
  return <Component className={`${ui.panel} p-4 ${className}`}>{children}</Component>;
}
