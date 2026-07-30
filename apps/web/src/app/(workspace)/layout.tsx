import type { ReactNode } from "react";
import { AuthGate } from "../../features/auth/auth-gate";
import { WorkspaceShell } from "../../features/workspace/workspace-shell";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AuthGate><WorkspaceShell>{children}</WorkspaceShell></AuthGate>;
}