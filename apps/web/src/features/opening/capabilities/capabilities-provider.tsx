"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  acceptCapabilitiesResponse,
  CLOSED_CAPABILITIES,
  type OpeningCapabilities,
} from "@aistudy/config/public";

/** Fail closed: everything off until the server says otherwise. */
export const OpeningCapabilitiesContext = createContext<OpeningCapabilities>(CLOSED_CAPABILITIES);

export function useOpeningCapabilities(): OpeningCapabilities {
  return useContext(OpeningCapabilitiesContext);
}

/** Digest inlined at next build via next.config `env`; compared to the server's runtime digest. */
const COMPILED_BUILD_CONFIG_DIGEST = process.env.AISTUDY_BUILD_CONFIG_DIGEST;

export function OpeningCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<OpeningCapabilities>(CLOSED_CAPABILITIES);
  useEffect(() => {
    let alive = true;
    fetch("/api/opening/capabilities", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((raw: unknown) => {
        if (!alive) return;
        const accepted = acceptCapabilitiesResponse(raw, COMPILED_BUILD_CONFIG_DIGEST);
        if (!accepted.compatible) console.warn(`opening capabilities disabled: ${accepted.reason}`);
        setCapabilities(accepted.capabilities);
      })
      .catch(() => {
        if (alive) setCapabilities(CLOSED_CAPABILITIES);
      });
    return () => {
      alive = false;
    };
  }, []);
  return <OpeningCapabilitiesContext.Provider value={capabilities}>{children}</OpeningCapabilitiesContext.Provider>;
}
