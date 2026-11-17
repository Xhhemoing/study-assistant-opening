import {
  adaptMaterialCourseFullPackage,
  type MaterialCourseFullPackage,
} from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { readMaterialPackagePreview } from "./material-package-preview-model";
import type { MaterialSkillRouteData } from "./material-skill-route-view";

/** Current author metadata (including private post-attempt fields), for local review only.
 * One input, never independently supplied candidate/topic snapshots. This module DOES run
 * the frozen R3 offline adapter; it is neither a first-answer DTO nor a course importer.
 */
export type MaterialWorkbenchHostProps = { input: MaterialCourseFullPackage | null | undefined };

/** The host owns authorization and file decoding; do not send this input to first-answer clients.
 * Capture once, validate/adapt once, and derive both child props from that same capture.
 * The preview boundary rejects polluted declared diagnostics rather than silently selecting.
 */
export function readMaterialWorkbench(input: unknown) {
  if (input == null) return null;
  try {
    const snapshot = structuredClone(input) as MaterialCourseFullPackage;
    const candidate = adaptMaterialCourseFullPackage(snapshot, { deadlineAt: null });
    if (!readMaterialPackagePreview(candidate)) return null;
    // The frozen adapter's external key schema trims IDs; mirror that normalization
    // for this one omitted field projection, including skills without questions.
    const skillTopics = snapshot.skills.map(({ id, topic }) => ({ id: id.trim(), topic }));
    // Allowlist the route's props instead of forwarding the whole offline candidate:
    // postAttemptMetadata stays outside this child, and is stripped by preview's projection.
    const route: MaterialSkillRouteData = { candidate: {
      topics: candidate.topics, routeInput: candidate.routeInput,
      prerequisiteOrder: candidate.prerequisiteOrder, questionMappings: candidate.questionMappings,
      coverageGaps: candidate.coverageGaps,
    }, skillTopics };
    return { candidate, route };
  } catch {
    // Invalid external snapshots close the entire composition. Never echo raw data/errors.
    return null;
  }
}
