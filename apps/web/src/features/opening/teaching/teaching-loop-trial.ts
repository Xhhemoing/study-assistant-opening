/**
 * V2-16 Experience — UI teaching-loop trial gate.
 * Full UI trial requires BOTH Integrator flags:
 *   OPENING_TEACHING_LOOP  (isOpeningTeachingLoopEnabled)
 *   OPENING_TEACHING_WORKSPACE (isOpeningTeachingWorkspaceEnabled)
 * Do not invent a third env parser; compose the existing helpers only.
 */

import { isOpeningTeachingLoopEnabled } from "./teaching-loop-flag";
import { isOpeningTeachingWorkspaceEnabled } from "./teaching-workspace-flag";

export type TeachingLoopTrialGate = {
  loopEnabled: boolean;
  workspaceEnabled: boolean;
  /** True only when both loop and workspace flags are on. */
  trialEnabled: boolean;
};

export function resolveTeachingLoopTrialGate(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): TeachingLoopTrialGate {
  const loopEnabled = isOpeningTeachingLoopEnabled(env);
  const workspaceEnabled = isOpeningTeachingWorkspaceEnabled(env);
  return {
    loopEnabled,
    workspaceEnabled,
    trialEnabled: loopEnabled && workspaceEnabled,
  };
}

/** Convenience: both flags on → TeachingWorkspace / continue entry may mount. */
export function isOpeningTeachingLoopTrialEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return resolveTeachingLoopTrialGate(env).trialEnabled;
}
