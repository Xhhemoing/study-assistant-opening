import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_INTERVENTION_PREFS, interventionPrefsSchema } from "@aistudy/contracts";
import { readOpeningBackupCourseRecords } from "./opening-backup-course-records";

describe("opening backup preference compatibility", () => {
  it("exports workspace intervention settings accepted by the pinned strict reader", async () => {
    const query = vi.fn(async (parts: TemplateStringsArray) => {
      const text = parts.join(" ");
      if (text.includes("FROM workspace_preferences")) {
        const interventionSettings = text.includes("- 'timetableRevision'")
          ? { ...DEFAULT_OPENING_INTERVENTION_PREFS }
          : { ...DEFAULT_OPENING_INTERVENTION_PREFS, timetableRevision: "11111111-1111-4111-8111-111111111111" };
        return [{ workspace_id: "workspace", intervention_settings: interventionSettings }];
      }
      return [];
    });
    const snapshot = await readOpeningBackupCourseRecords(query as never, "workspace", []);
    expect(() => interventionPrefsSchema.parse(snapshot.workspace_preferences[0]!.intervention_settings)).not.toThrow();
  });
});
