import type { LearningEvent, StatusResult } from "@aistudy/contracts";
import {
  correctionFromLearningEvent,
  deriveStatus,
  evidenceFromLearningEvent,
  type AssessmentOptions,
  type EvidenceEvent,
  type StatusCorrection,
} from "@aistudy/domain";

export function statusesFromEvents(
  events: LearningEvent[],
  now: Date,
  options: AssessmentOptions = {},
): StatusResult[] {
  const grouped = new Map<string, LearningEvent[]>();
  for (const event of events) {
    if (!event.syllabusPointId) continue;
    const list = grouped.get(event.syllabusPointId) ?? [];
    list.push(event);
    grouped.set(event.syllabusPointId, list);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([pointId, list]) => {
      const evidence = list
        .map(evidenceFromLearningEvent)
        .filter((item): item is EvidenceEvent => item !== null);
      const corrections = list
        .map(correctionFromLearningEvent)
        .filter((item): item is StatusCorrection => item !== null);
      return deriveStatus(pointId, evidence, now, corrections, options);
    });
}
