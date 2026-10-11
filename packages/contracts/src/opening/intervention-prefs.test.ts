import { describe, expect, it } from "vitest";
import {
  CONSECUTIVE_PROACTIVE_REJECT_LIMIT,
  DEFAULT_OPENING_INTERVENTION_PREFS,
  INTERVENTION_DECISION_RING_MAX,
  interventionDecisionRecordSchema,
  interventionPrefsPatchSchema,
  interventionPrefsSchema,
  interventionSettingsResponseSchema,
} from "./intervention-prefs";

describe("intervention-prefs contracts (T1)", () => {
  it("accepts DEFAULT and rejects unknown keys", () => {
    expect(interventionPrefsSchema.parse(DEFAULT_OPENING_INTERVENTION_PREFS)).toEqual(
      DEFAULT_OPENING_INTERVENTION_PREFS,
    );
    expect(DEFAULT_OPENING_INTERVENTION_PREFS.proactivity).toBe("balanced");
    expect(DEFAULT_OPENING_INTERVENTION_PREFS.depth).toBe("hint_then_offer");
    expect(
      interventionPrefsSchema.safeParse({
        ...DEFAULT_OPENING_INTERVENTION_PREFS,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects dwellStuck / mustAskEvery / allowOnDwell / intervalMinutes fields", () => {
    expect(
      interventionPrefsSchema.safeParse({
        ...DEFAULT_OPENING_INTERVENTION_PREFS,
        dwellStuck: true,
      }).success,
    ).toBe(false);
    expect(
      interventionPrefsSchema.safeParse({
        ...DEFAULT_OPENING_INTERVENTION_PREFS,
        mustAskEvery: 5,
      }).success,
    ).toBe(false);
    expect(
      interventionPrefsSchema.safeParse({
        ...DEFAULT_OPENING_INTERVENTION_PREFS,
        intervalMinutes: 10,
      }).success,
    ).toBe(false);
    expect(
      interventionPrefsSchema.safeParse({
        ...DEFAULT_OPENING_INTERVENTION_PREFS,
        nodes: {
          ...DEFAULT_OPENING_INTERVENTION_PREFS.nodes,
          allowOnDwell: true,
        },
      }).success,
    ).toBe(false);
  });

  it("parses deep-partial patch and decision record", () => {
    expect(
      interventionPrefsPatchSchema.parse({
        quietMode: true,
        nodes: { allowOnLowEvidence: true },
      }),
    ).toEqual({ quietMode: true, nodes: { allowOnLowEvidence: true } });
    expect(interventionPrefsPatchSchema.safeParse({ nodes: { allowOnDwell: false } }).success).toBe(
      false,
    );
    const record = interventionDecisionRecordSchema.parse({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      at: "2026-10-11T04:00:00.000Z",
      activityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      trigger: "system_proactive",
      decision: "none",
      reason: "quiet_mode",
      proposedKind: "guided",
      prefsSnapshot: {
        proactivity: "balanced",
        quietMode: true,
        depth: "hint_then_offer",
      },
    });
    expect(record.decision).toBe("none");
  });

  it("locks ring max and consecutive reject constants", () => {
    expect(INTERVENTION_DECISION_RING_MAX).toBe(20);
    expect(CONSECUTIVE_PROACTIVE_REJECT_LIMIT).toBe(2);
  });

  it("parses settings response shape", () => {
    const parsed = interventionSettingsResponseSchema.parse({
      settings: DEFAULT_OPENING_INTERVENTION_PREFS,
      courseOverride: { quietMode: true },
      sessionOverride: null,
      effective: { ...DEFAULT_OPENING_INTERVENTION_PREFS, quietMode: true },
      saved: true,
      invalidStoredSettings: false,
    });
    expect(parsed.effective.quietMode).toBe(true);
  });
});
