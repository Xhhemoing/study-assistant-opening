/**
 * V2-10 feature flag — default off.
 * Server-only (PR-H): no NEXT_PUBLIC_* twin; the browser reads /api/opening/capabilities.
 */

export function isOpeningTeachingWorkspaceEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.OPENING_TEACHING_WORKSPACE ??
    ""
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
