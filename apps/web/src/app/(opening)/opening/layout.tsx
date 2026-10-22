import type { ReactNode } from "react";
import { AuthGate } from "../../../features/auth/auth-gate";
import { OpeningCapabilitiesProvider } from "../../../features/opening/capabilities/capabilities-provider";
import { OpeningShellV3 } from "../../../features/opening/shell/opening-shell-v3";

export default function OpeningLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <OpeningCapabilitiesProvider>
        <OpeningShellV3>{children}</OpeningShellV3>
      </OpeningCapabilitiesProvider>
    </AuthGate>
  );
}
