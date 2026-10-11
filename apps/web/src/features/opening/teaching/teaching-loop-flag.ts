/**
 * V2-16 feature flag — default off.
 * Internal trial gate for the composed teaching loop (enter→…→resume).
 * Client bundles may only see NEXT_PUBLIC_*; server/tests may use OPENING_TEACHING_LOOP.
 * Full UI trial also requires OPENING_TEACHING_WORKSPACE (both on) — see Plan ACCEPT.
 */

export function isOpeningTeachingLoopEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.OPENING_TEACHING_LOOP ??
    env.NEXT_PUBLIC_OPENING_TEACHING_LOOP ??
    ""
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
