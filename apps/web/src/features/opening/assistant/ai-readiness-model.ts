export type AiReadinessChecklistItem = {
  key: string;
  ok: boolean;
  detail: string;
  fixHint: string;
  severity?: "hard" | "soft";
};

/** Soft readiness rows must not keep "AI unavailable" open (vision is photo-only). */
export function isAiReadinessChecklistHardBlocker(item: AiReadinessChecklistItem): boolean {
  if (item.ok) return false;
  if (item.severity === "soft") return false;
  if (item.severity === "hard") return true;
  // Legacy payloads without severity: vision + reconcile stay soft.
  return item.key !== "vision_model" && item.key !== "reconciled_unknown";
}
