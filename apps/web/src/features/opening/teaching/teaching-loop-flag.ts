/**
 * V2-16 feature flag — default off.
 * Internal trial gate for the composed teaching loop (enter→…→resume).
 * Server-only (PR-H): no NEXT_PUBLIC_* twin; the browser reads /api/opening/capabilities.
 * Full UI trial also requires OPENING_TEACHING_WORKSPACE (both on) — see Plan ACCEPT.
 */

export function isOpeningTeachingLoopEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.OPENING_TEACHING_LOOP ??
    ""
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
