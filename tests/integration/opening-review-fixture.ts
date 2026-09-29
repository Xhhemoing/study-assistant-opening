import { randomUUID } from "node:crypto";
import { createOpeningRetestRepository, createWorkspacePreferencesRepository, type OpeningScope } from "@aistudy/database";
import type { OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
export async function seedReviewRetest(fixture: OpeningFixture, scope: OpeningScope = fixture.scope) {
  // This fixture represents an explicitly enabled retest workflow.
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(scope, {
    assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false,
  });
  const courseId = randomUUID(), sourceId = await backupRows(fixture.sql, scope).source(), id = randomUUID();
  await fixture.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseId}, ${scope.workspaceId}, 'Review course', ${courseId})`;
  const candidate = { id, courseId, skillLabel: "线性代数", prompt: "独立再做一道题", sourceIds: [sourceId], dueAt: "2026-10-01T00:00:00.000Z", accepted: false };
  await createOpeningRetestRepository(fixture.sql).saveCandidates(scope, [candidate]);
  return { ...candidate, sourceId };
}
