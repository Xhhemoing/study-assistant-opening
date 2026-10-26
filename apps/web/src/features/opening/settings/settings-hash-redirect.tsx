"use client";
import { useEffect } from "react";
import { settingsHashTarget } from "./settings-route-target";

/** URL fragments never reach the server; old bookmark fragments need client navigation. */
export function SettingsHashRedirect({ basePath }: { basePath: string }) {
  useEffect(() => {
    const replace = () => {
      if (window.location.pathname !== basePath) return;
      const target = settingsHashTarget(basePath, window.location.hash, window.location.search);
      if (target) window.location.replace(target);
    };
    replace(); window.addEventListener("hashchange", replace);
    return () => window.removeEventListener("hashchange", replace);
  }, [basePath]);
  return null;
}
