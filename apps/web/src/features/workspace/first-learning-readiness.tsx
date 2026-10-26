"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { z } from "zod";
import { isAiReadinessChecklistHardBlocker, type AiReadinessChecklistItem } from "../opening/assistant/ai-readiness-model";
import { TransitionLink as Link } from "../opening/v3/motion/view-transition";
import { ui } from "../opening/design/ui";

const readinessResponse = z.object({ items: z.array(z.object({
  key: z.string(), ok: z.boolean(), detail: z.string(), fixHint: z.string(),
  severity: z.enum(["hard", "soft"]).optional(),
  status: z.enum(["not_configured", "missing_files", "preflight_failed", "ready", "unknown"]).optional(),
})) });

/** A failed read is unknown; only the readiness contract can confirm a blocker. */
export function FirstLearningReadiness({ draftKey }: { draftKey: string }) {
  const [blocker, setBlocker] = useState<AiReadinessChecklistItem | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const dismissalKey = `${draftKey}:ai-readiness-dismissed`;
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(dismissalKey) === "1") { setDismissed(true); return; }
    } catch { /* Storage can be disabled; dismissal still works for this mount. */ }
    setDismissed(false); setBlocker(null);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/opening/ai-readiness", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const parsed = readinessResponse.safeParse(await response.json());
        if (!controller.signal.aborted && parsed.success) {
          setBlocker(parsed.data.items.find(item => item.status !== "unknown" && isAiReadinessChecklistHardBlocker(item)) ?? null);
        }
      } catch { /* Readiness is optional guidance; a transport failure confirms nothing. */ }
    })();
    return () => controller.abort();
  }, [dismissalKey]);
  function dismiss() {
    setDismissed(true);
    try { window.sessionStorage.setItem(dismissalKey, "1"); } catch { /* Do not block the learning form when storage is unavailable. */ }
  }
  if (!blocker || dismissed) return null;
  return <section aria-label="AI 就绪提醒" className="flex items-start gap-3 rounded-lg bg-warn-soft p-3" role="status">
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-sm font-medium text-warn">AI 辅导暂不可用</p>
      <p className="text-xs leading-6 text-text-2">{blocker.detail}</p>
      <Link className={ui.quiet} href="/opening/settings/ai">检查 AI 设置</Link>
    </div>
    <button type="button" className={ui.icon} aria-label="关闭 AI 就绪提醒" onClick={dismiss}><X size={16} aria-hidden="true" /></button>
  </section>;
}
