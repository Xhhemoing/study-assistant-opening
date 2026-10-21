"use client";

import { useDiagnosticsEnabled } from "../settings/appearance-preferences";

export function SourceVersionDetails({ requestedVersion, currentVersion }: { requestedVersion: number; currentVersion: number }) {
  const diagnostics = useDiagnosticsEnabled();
  if (!diagnostics) return null;
  return <details className="text-xs leading-6 text-text-3">
    <summary className="min-h-8 cursor-pointer rounded py-1.5 focus-visible:ring-2 focus-visible:ring-accent">资料诊断</summary>
    <p>引用版本：{requestedVersion} · 当前版本：{currentVersion}</p>
  </details>;
}
