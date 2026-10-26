import type { ActivitySpecClientInit, LearningResume } from "@aistudy/contracts";
import { resolveTeachingBlockFocus } from "@aistudy/domain";
import { buildTeachingStudyUnits } from "./study-unit-focus";

type ProgressResume = Pick<LearningResume, "activityId" | "contentVersion"> & {
  clientInit: Pick<ActivitySpecClientInit, "activityId" | "contentVersion" | "blocks" | "checkpointJson"> | null;
};

/** The workspace's current block expressed in teaching units, never completion or mastery. */
export function unitProgress(
  activity: { id?: string; contentVersion?: number } | null | undefined,
  resume: ProgressResume | null | undefined,
): { current: number; total: number } | null {
  const init = resume?.clientInit;
  if (!activity?.id || !resume || !init || resume.activityId !== activity.id
    || init.activityId !== activity.id || resume.contentVersion !== activity.contentVersion
    || init.contentVersion !== resume.contentVersion) return null;
  const units = buildTeachingStudyUnits(init.blocks);
  const blocks = units.flatMap(unit => unit.blocks);
  const cursor = init.checkpointJson?.currentBlockId;
  if (typeof cursor === "string" && !blocks.some(block => block.blockId === cursor)) return null;
  // Both entry points use the checkpoint bundled with these blocks, rather than an earlier thoughtTrain read.
  const focus = resolveTeachingBlockFocus(blocks, init.checkpointJson);
  const index = units.findIndex(unit => unit.blocks.some(block => block.blockId === focus.currentBlockId));
  return index < 0 ? null : { current: index + 1, total: units.length };
}
