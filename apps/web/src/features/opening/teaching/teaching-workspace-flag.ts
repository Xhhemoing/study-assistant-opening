/**
 * V2-10 feature flag — default off.
 * Client bundles may only see NEXT_PUBLIC_*; server/tests may use OPENING_TEACHING_WORKSPACE.
 */

export function isOpeningTeachingWorkspaceEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (
    env.OPENING_TEACHING_WORKSPACE ??
    env.NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE ??
    ""
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
