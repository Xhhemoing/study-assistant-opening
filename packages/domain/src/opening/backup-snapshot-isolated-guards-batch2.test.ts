import { describe, expect, it } from "vitest";
import { validateBackupStudy } from "./backup-study";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspace = uuid(1), owner = uuid(2), conversation = uuid(3), user = uuid(4), assistant = uuid(5);
const session = uuid(6), attempt = uuid(7), exposure = uuid(8), foreign = uuid(9);
const scope = { workspace_id: workspace, owner_user_id: owner };
const snapshot = () => ({ userTurnId: user, assistantTurnId: assistant, tutorMode: "hint", studyIntent: null });
function fixture(): Tables {
  return {
    opening_conversations: [{ ...scope, id: conversation }],
    opening_turns: [
      { ...scope, id: user, conversation_id: conversation, role: "user", mode: "hint", learning_session_id: session, attempt_id: attempt, help_input_snapshot: snapshot() },
      { ...scope, id: assistant, conversation_id: conversation, role: "assistant", learning_session_id: session, attempt_id: attempt },
    ],
    opening_help_exposures: [{ ...scope, id: exposure, session_id: session, attempt_id: attempt, turn_id: assistant, help_input_snapshot: snapshot(), release_key: null }],
  };
}
function errors(tables: Tables) { const output: string[] = []; validateBackupStudy(tables, output); return output; }
const mismatch = "Help input snapshot user turn scope or identity mismatch";
function roundTrip(tables: Tables, target: Row, field: string, value: unknown, diagnostics = 1) {
  const baseline = structuredClone(tables), old = target[field];
  expect(errors(tables)).toEqual([]);
  target[field] = value;
  const negative = structuredClone(tables);
  // Assert the exact diagnostics, not merely any rejection; each saved input validates its pair.
  expect(errors(tables)).toEqual(Array.from({ length: diagnostics }, () => mismatch));
  expect(tables).toEqual(negative);
  if (old === undefined) delete target[field]; else target[field] = old;
  expect(tables).toEqual(baseline); expect(errors(tables)).toEqual([]);
}

describe("batch2 immutable model-input snapshot relationships; one veto per case", () => {
  it.each(["role", "workspace_id", "owner_user_id"] as const)("isolates original user %s", field => {
    const t = fixture(); roundTrip(t, t.opening_turns![0]!, field, field === "role" ? "assistant" : foreign, 2);
  });
  it.each(["role", "workspace_id", "owner_user_id", "conversation_id", "learning_session_id", "attempt_id"] as const)("isolates assistant %s", field => {
    const t = fixture(); roundTrip(t, t.opening_turns![1]!, field, field === "role" ? "user" : foreign, 2);
  });
  it.each(["turn_id", "session_id", "attempt_id"] as const)("isolates exposure %s against already-matching user/assistant pair", field => {
    const t = fixture(); roundTrip(t, t.opening_help_exposures![0]!, field, foreign);
  });
  it("exposure snapshot mode mismatch alone cannot borrow another original input", () => {
    const t = fixture(); roundTrip(t, t.opening_help_exposures![0]!.help_input_snapshot as Row, "tutorMode", "explain");
  });
  it("user turn mode must agree with its own saved snapshot even without exposure rows", () => {
    const t = fixture(); t.opening_help_exposures = [];
    roundTrip(t, t.opening_turns![0]!, "mode", "listen");
  });
  it("missing assistant is allowed only for the saved input, not a delivered exposure pair", () => {
    const t = fixture(); t.opening_turns!.pop();
    const before = structuredClone(t); expect(errors(t)).toEqual([mismatch]); expect(t).toEqual(before);
    t.opening_help_exposures = [];
    expect(errors(t)).toEqual([]);
    expect(t.opening_turns![0]!.help_input_snapshot).toEqual(snapshot());
  });
  it("missing assistant is itself a veto even without a conflicting exposure turn_id", () => {
    const t = fixture(); t.opening_turns!.pop(); delete t.opening_help_exposures![0]!.turn_id;
    expect(errors(t)).toEqual([mismatch]);
    t.opening_turns!.push(fixture().opening_turns![1]!);
    t.opening_help_exposures![0]!.turn_id = assistant;
    expect(errors(t)).toEqual([]);
  });
  it("missing user cannot be substituted by an assistant carrying the same content-free input", () => {
    const t = fixture(); t.opening_turns!.shift();
    expect(errors(t)).toEqual([mismatch]);
    t.opening_turns!.unshift(fixture().opening_turns![0]!); expect(errors(t)).toEqual([]);
  });
  it("same-purpose but different user/assistant identities are not equal snapshots", () => {
    const t = fixture(); const otherUser = uuid(10), otherAssistant = uuid(11);
    const otherSnapshot = { ...snapshot(), userTurnId: otherUser, assistantTurnId: otherAssistant };
    t.opening_turns!.push({ ...t.opening_turns![0]!, id: otherUser, help_input_snapshot: otherSnapshot }, { ...t.opening_turns![1]!, id: otherAssistant });
    const e = t.opening_help_exposures![0]!;
    e.help_input_snapshot = otherSnapshot; e.turn_id = otherAssistant;
    expect(errors(t)).toEqual([]);
    // Identity links stay valid; only the captured input on that new user is different.
    (t.opening_turns![2]!.help_input_snapshot as Row).tutorMode = "explain";
    t.opening_turns![2]!.mode = "explain";
    // Avoid a shared fixture object concealing the mismatch.
    e.help_input_snapshot = { ...otherSnapshot, tutorMode: "hint" };
    expect(errors(t)).toEqual([mismatch]);
  });
  it.each([null, undefined])("legacy absent input %s stays unknown, not synthesized from other turns", helpInput => {
    const t = fixture(); t.opening_turns![0]!.help_input_snapshot = helpInput; t.opening_help_exposures![0]!.help_input_snapshot = helpInput;
    const before = structuredClone(t); expect(errors(t)).toEqual([]); expect(t).toEqual(before);
  });
});
