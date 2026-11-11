import { describe, expect, it } from "vitest";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { OpeningApiError } from "../client/api";
import { currentHistoryRecord, observationRevisionCommand, observationRevisionDraft, observationRevisionFailure,
  reloadObservationRevisionEditor, type ObservationRevisionEditor } from "./observation-revision-model";

const headId = "88888888-8888-4888-8888-888888888888";
function fixture(): ObservationRevisionEditor {
  return { record: learningObservation, expectedHead: learningObservation.id,
    draft: { ...observationRevisionDraft(learningObservation), answer: "synthetic unsaved correction" },
    reason: "synthetic correction reason", revisionKind: "replace", conflict: true };
}

describe("observation correction does not contaminate saved history (pure)", () => {
  it.each(["replace", "retract"] as const)("concurrent reload preserves %s intent but rebases only head identity", revisionKind => {
    const editor = { ...fixture(), revisionKind };
    const next = { ...learningObservation, id: headId, rootObservationId: learningObservation.id, answer: "other synthetic correction", revisionKind: "replace" as const };
    const history = { rootObservationId: learningObservation.id, headObservationId: headId, revisions: [next, learningObservation] };
    const before = structuredClone({ editor, history });
    const refreshed = reloadObservationRevisionEditor(editor, history);
    expect(refreshed).toEqual({ ...editor, record: next, expectedHead: headId, conflict: false });
    expect(observationRevisionCommand({ ...refreshed, clientKey: "isolation-command" })).toMatchObject({ rootObservationId: learningObservation.id, revisesObservationId: headId, expectedHead: headId, revisionKind });
    expect({ editor, history }).toEqual(before);
  });

  it.each(["replace", "retract"] as const)("missing concurrent head fails closed without altering pending %s draft", revisionKind => {
    const editor = { ...fixture(), revisionKind }, before = structuredClone(editor);
    const history = { rootObservationId: learningObservation.id, headObservationId: headId, revisions: [learningObservation] };
    expect(() => currentHistoryRecord(history)).toThrow();
    expect(() => reloadObservationRevisionEditor(editor, history)).toThrow();
    expect(editor).toEqual(before);
  });

  it.each(["correct", "incorrect", "unverified"] as const)("changed answer outcome %s cannot inherit old reference verification", outcome => {
    const editor = fixture(); editor.draft.outcome = outcome;
    const before = structuredClone(editor);
    const command = observationRevisionCommand({ ...editor, clientKey: "isolation-command" });
    expect(command).toMatchObject({ replacement: { answer: editor.draft.answer, outcome, verdictSource: "self_report", referenceSourceId: null } });
    expect(command).not.toHaveProperty("attemptId"); expect(command).not.toHaveProperty("itemVersionId");
    expect(editor).toEqual(before);
  });

  it.each([403, 404, 409, 503])("status %s is classified without exposing private server payload", status => {
    const secret = "SYNTHETIC_PRIVATE_HISTORY_PAYLOAD";
    const result = observationRevisionFailure(new OpeningApiError(status, secret));
    expect(result.kind).toBe(status === 409 ? "conflict" : status === 403 || status === 404 ? "unavailable" : "error");
    expect(result.message).not.toContain(secret);
  });

  it("retraction contains no draft answer/reference payload", () => {
    const editor = fixture(); editor.revisionKind = "retract";
    const command = observationRevisionCommand({ ...editor, clientKey: "isolation-retract" });
    expect(command).not.toHaveProperty("replacement");
    expect(JSON.stringify(command)).not.toContain(editor.draft.answer);
    expect(command.rootObservationId).toBe(learningObservation.id);
  });
});
