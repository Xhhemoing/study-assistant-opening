import type { ReactNode } from "react";
import { AuthGate } from "../../../features/auth/auth-gate";
import { OpeningShell } from "../../../features/opening/shell/opening-shell";

export default function OpeningLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <OpeningShell>{children}</OpeningShell>
    </AuthGate>
  );
}
