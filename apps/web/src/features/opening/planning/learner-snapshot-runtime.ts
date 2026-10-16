import type { Sql } from "postgres";
import {
  createCardRepository,
  createOpeningAdaptivePrefsRepository,
  readOpeningCourseEvidence,
  readOpeningLearnerSnapshotBase,
} from "@aistudy/database";
import { assembleLearnerSnapshot } from "@aistudy/domain";
import { createLearnerSnapshotService } from "./learner-snapshot-service";

/** Shared production wiring for planning and teaching; never calls a model. */
export function createSqlLearnerSnapshotService(sql: Sql, options: { now?: () => Date } = {}) {
  const prefs = createOpeningAdaptivePrefsRepository(sql);
  const cards = createCardRepository(sql);
  return createLearnerSnapshotService({
    readBase: scope => readOpeningLearnerSnapshotBase(sql, scope),
    readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(sql, scope, courseId),
    readAdaptivePrefs: scope => prefs.get(scope),
    countDueCards: async (scope, input) => (await cards.listQueue({
      ...scope, mode: "auto", now: input.now, timeZone: input.timeZone,
    })).length,
    assembleSnapshot: assembleLearnerSnapshot,
    onReadFailure: source => console.warn("Opening learner snapshot read unavailable", { source }),
    ...options,
  });
}
