import { describe, expect, it } from "vitest";
import { validateBackupStudy } from "./backup-study";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
const w = "10000000-0000-4000-8000-000000000001", u = "20000000-0000-4000-8000-000000000001";
const activity = "30000000-0000-4000-8000-000000000001", exposure = "40000000-0000-4000-8000-000000000001";
const attempt = "50000000-0000-4000-8000-000000000001", decision = "60000000-0000-4000-8000-000000000001";
const time = "2026-10-19T10:00:00.000Z";
const scope = { workspace_id: w, owner_user_id: u };
function tables() {
  return { opening_teaching_activities: [{ ...scope, id: activity, course_id: null }],
    opening_help_exposures: [{ ...scope, id: exposure, release_key: "release-test-key", context_anchor: { activityId: activity, purpose: "learning_help" },
      exposure_origin: "assistant", support_domain: "unknown", generated_at: time, released_at: null, acknowledged_at: null, delivered: false }],
    opening_workspace_history_revisions: [{ ...scope, revision: 3 }] } as Record<string, Record<string, unknown>[]>;
}
function errors(input: ReturnType<typeof tables>) { const result: string[] = []; validateBackupStudy(input, result); return result; }

describe("Study backup history", () => {
  it("preserves generated, released and acknowledged receipts without inferring acknowledgement", () => {
    const value = tables(), row = value.opening_help_exposures![0]!;
    expect(errors(value)).toEqual([]);
    row.released_at = time; row.delivered = true; row.workspace_history_revision = 2;
    expect(errors(value)).toEqual([]);
    expect(row.acknowledged_at).toBeNull();
    row.acknowledged_at = time;
    expect(errors(value)).toEqual([]);
    row.delivered = false;
    expect(errors(value).some(error => error.includes("states are inconsistent"))).toBe(true);
  });
  it("rejects a missing anchor target and a release newer than its workspace counter", () => {
    const value = tables();
    value.opening_teaching_activities = [];
    expect(errors(value)).toContain("Study anchor activity scope or identity mismatch");
    const released = tables(), row = released.opening_help_exposures![0]!;
    row.released_at = time; row.delivered = true; row.workspace_history_revision = 4;
    expect(errors(released)).toContain("Study exposure workspace history counter is missing or behind");
  });
  it("keeps legacy unknown anchors and old delivered rows unknown", () => {
    const value = tables(); value.opening_help_exposures = [{ ...scope, delivered: true, release_key: null, context_anchor: null }];
    expect(errors(value)).toEqual([]);
    expect(value.opening_help_exposures[0]).toMatchObject({ context_anchor: null, release_key: null });
  });
  it("validates immutable Decision targets, source receipts and parent layers", () => {
    const value = tables();
    const receipt = { layer: "activity", targetId: activity, parentDecisionId: null, stateVersion: "s1", goalVersion: "g1", intentVersion: "i1", policyVersion: "p1",
      candidates: [{ action: "explain", eligible: true, reasonCodes: ["unobserved"], evidenceRefs: [] }], selectedAction: "explain", reasonCodes: ["unobserved"],
      evidenceRefs: [], sourceVersions: {}, dataAsOf: time, invalidationConditions: ["state_changed"] };
    value.opening_learning_decisions = [{ ...scope, id: decision, layer: "activity", target_id: activity, parent_decision_id: null, client_key: "decision-key", receipt, created_at: time }];
    expect(errors(value)).toEqual([]);
    value.opening_learning_decisions[0]!.parent_decision_id = decision;
    (receipt as Record<string, unknown>).parentDecisionId = decision;
    expect(errors(value)).toContain("Decision parent layer or scope mismatch");
  });
  it("keeps pre-answer shadow forecasts as historical records and rejects missing attempts", () => {
    const value = tables();
    value.opening_learning_attempts = [{ ...scope, id: attempt, course_id: null, requirement_key: null, context_anchor: null }];
    value.opening_learning_shadow_predictions = [{ ...scope, attempt_id: attempt, course_id: null, requirement_key: null, family_key: null,
      input_cutoff: time, captured_at: time, state_version: "v1", receipt: { mode: "shadow", calibrated: false, target: "next_independent_verified_correct", familyKey: null,
        unavailableReason: "canonical_family_or_requirement_unavailable" } }];
    expect(errors(value)).toEqual([]);
    const receipt = value.opening_learning_shadow_predictions[0]!.receipt as Record<string, unknown>;
    receipt.evidenceObservationIds = "not-an-array";
    expect(errors(value)).toContain("Shadow prediction identity or receipt is invalid");
    receipt.evidenceObservationIds = [];
    value.opening_learning_attempts = [];
    expect(errors(value)).toContain("Shadow prediction identity or receipt is invalid");
  });
  it("rejects budgets and pending proposals in user restore archives", () => {
    const backup: OpeningBackup = { format: "opening-backup", version: 1, workspaceId: w, privacyEpoch: 0, deletionJournal: [], objects: [], tables: {} };
    for (const name of ["opening_parent_interaction_budgets", "opening_budget_reservations", "opening_assistant_proposals"]) {
      backup.tables = { [name]: [{ ...scope, status: "draft" }] };
      expect(validateOpeningRestore(backup, []).errors).toContain(`table ${name} is not allowlisted`);
    }
  });
});

it("retains every intent event and binds copied/guessed declarations to their actual attempt", () => {
  const value = tables(), session = "70000000-0000-4000-8000-000000000001", second = "80000000-0000-4000-8000-000000000001";
  const intent = { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
  value.opening_learning_sessions = [{ ...scope, id: session, activity_id: activity }];
  value.opening_learning_attempts = [{ ...scope, id: attempt, session_id: session, activity_id: activity }];
  value.opening_study_intent_events = ["copied_answer", "guessed"].map((signal, index) => ({ ...scope, id: index ? second : decision,
    session_id: session, activity_id: activity, attempt_id: attempt, version: index + 1, client_key: `intent-event-${index}`,
    event_kind: "signal", payload: { kind: "signal", signal, signals: [signal] }, resulting_intent: intent, action: "continue", created_at: time }));
  value.opening_teaching_activities![0]!.goal_json = { sessionIntentEventId: second, sessionIntentVersion: 2 };
  expect(errors(value)).toEqual([]);
  const receipt = { layer: "activity", targetId: activity, stateVersion: "s1", goalVersion: "g1", intentVersion: `${second}:v2`, policyVersion: "p1",
    candidates: [{ action: "explain", eligible: true, reasonCodes: ["unobserved"], evidenceRefs: [] }], selectedAction: "explain", reasonCodes: ["unobserved"],
    evidenceRefs: [], sourceVersions: {}, dataAsOf: time, invalidationConditions: ["state_changed", "intent_changed"] };
  value.opening_learning_decisions = [{ ...scope, id: exposure, layer: "activity", target_id: activity, parent_decision_id: null, client_key: "event-decision", receipt, created_at: time }];
  expect(errors(value)).toEqual([]);
  receipt.intentVersion = `${second}:v3`;
  expect(errors(value)).toContain("Decision intent event reference is missing or mismatched");
  receipt.intentVersion = `${second}:v2`;
  const saved = structuredClone(value.opening_study_intent_events);
  value.opening_study_intent_events.shift();
  expect(errors(value)).toContain("Study intent event history is incomplete or duplicated");
  value.opening_study_intent_events = saved;
  value.opening_study_intent_events[0]!.attempt_id = null;
  expect(errors(value)).toContain("Study answer-condition signals are missing their original attempt");
  value.opening_study_intent_events[0]!.attempt_id = attempt;
  (value.opening_study_intent_events[0]!.payload as Record<string, unknown>).signals = [];
  expect(errors(value)).toContain("Study answer-condition signals are missing their original attempt");
});
