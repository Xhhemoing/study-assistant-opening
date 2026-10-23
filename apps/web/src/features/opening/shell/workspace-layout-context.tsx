"use client";

import { createContext, useContext } from "react";

export type WorkspaceLayout = {
  focusMode: boolean;
  setFocusMode: (next: boolean) => void;
  toggleFocusMode: () => void;
};

/** Shell and the mounted learning workspace share the same explicit focus choice. */
export const WorkspaceLayoutContext = createContext<WorkspaceLayout>({
  focusMode: false,
  setFocusMode: () => {},
  toggleFocusMode: () => {},
});

export function useWorkspaceLayout(): WorkspaceLayout {
  return useContext(WorkspaceLayoutContext);
}
