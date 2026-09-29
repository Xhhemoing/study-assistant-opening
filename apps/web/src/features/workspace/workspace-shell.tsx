"use client";

import type { ReactNode } from "react";
import { OpeningShell } from "../opening/shell/opening-shell";

export function WorkspaceShell({ children }: { children: ReactNode }) {
  return <OpeningShell>{children}</OpeningShell>;
}
