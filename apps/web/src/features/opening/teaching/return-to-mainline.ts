import type { TeachingCommandConflict, TeachingCommandSuccess } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { branchStackDepth, newTeachingCommandClientKey } from "./block-commands";

/** Old branch checkpoints return through the same CAS API when the learner closes a follow-up. */
export async function returnToMainline({ api, activityId, contentVersion, pathVersion, checkpoint, accept, onConflict, isCurrent = () => true }: {
  api: OpeningApi; activityId: string; contentVersion: number; pathVersion: number;
  checkpoint: Record<string, unknown> | null | undefined;
  accept: (result: TeachingCommandSuccess) => boolean;
  onConflict?: (conflict: TeachingCommandConflict) => void;
  isCurrent?: () => boolean;
}) {
  let remaining = branchStackDepth(checkpoint);
  while (remaining > 0) {
    if (!isCurrent()) return;
    const result = await api.postTeachingCommand(activityId, {
      kind: "return", clientKey: newTeachingCommandClientKey(), expectedVersion: contentVersion, expectedPathVersion: pathVersion,
    });
    if (!isCurrent()) return;
    if (!result.ok) { onConflict?.(result); return; }
    if (!accept(result)) return;
    const next = branchStackDepth(result.checkpointJson);
    if (next >= remaining) throw new Error("原学习位置尚未确认，请重新读取后继续。");
    remaining = next; contentVersion = result.contentVersion; pathVersion = result.pathVersion;
  }
}
