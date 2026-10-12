import type { ReactNode } from "react";
import { AuthGate } from "../../../features/auth/auth-gate";
import { OpeningCapabilitiesProvider } from "../../../features/opening/capabilities/capabilities-provider";
import { OpeningShell } from "../../../features/opening/shell/opening-shell";

export default function OpeningLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <OpeningCapabilitiesProvider>
        <OpeningShell>{children}</OpeningShell>
      </OpeningCapabilitiesProvider>
    </AuthGate>
  );
}
