import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { OpeningApiError } from "../client/api";
import { ObservationRevisionCard, observationHistoryPanelReducer } from "./observation-revision-card";
import { currentHistoryRecord, observationRevisionCommand, observationRevisionDraft, observationRevisionFailure, reloadObservationRevisionEditor, type ObservationRevisionEditor } from "./observation-revision-model";

const headId = "88888888-8888-4888-8888-888888888888";
const editor: ObservationRevisionEditor = {
  record: learningObservation, expectedHead: learningObservation.id, draft: observationRevisionDraft(learningObservation),
  reason: "原回答录入有误", revisionKind: "replace", conflict: false,
};

describe("observation correction", () => {
  it("corrects only editable fields and deliberately drops old verification", () => {
    const command = observationRevisionCommand({ ...editor, draft: { ...editor.draft, answer: "corrected answer", requirementKey: "  requirement-b  " }, clientKey: "revision-command" });
    expect(command).toEqual({ rootObservationId: learningObservation.id, revisesObservationId: learningObservation.id, expectedHead: learningObservation.id,
      reason: editor.reason, clientKey: "revision-command", revisionKind: "replace", replacement: {
        answer: "corrected answer", outcome: "correct", assistance: "independent", courseId: learningObservation.courseId,
        skillLabel: "fractions", requirementKey: "requirement-b", verdictSource: "self_report", referenceSourceId: null,
      } });
  });

  it("keeps immutable practice identity outside a retraction command", () => {
    expect(observationRevisionCommand({ ...editor, revisionKind: "retract", clientKey: "revision-retract" })).toEqual({ rootObservationId: learningObservation.id,
      revisesObservationId: learningObservation.id, expectedHead: learningObservation.id, reason: editor.reason, clientKey: "revision-retract", revisionKind: "retract" });
  });

  it("requires a reason before sending either operation", () => {
    for (const revisionKind of ["replace", "retract"] as const) expect(() => observationRevisionCommand({ ...editor, revisionKind, reason: "  ", clientKey: "revision-command" })).toThrow();
  });

  it("reloads the concurrent head while preserving the entire draft and reason", () => {
    const next = { ...learningObservation, id: headId, rootObservationId: learningObservation.id, answer: "another editor's answer", revisionKind: "replace" as const };
    const pending = { ...editor, draft: { ...editor.draft, answer: "my unsaved answer", courseId: "99999999-9999-4999-8999-999999999999" }, conflict: true };
    const result = reloadObservationRevisionEditor(pending, { rootObservationId: learningObservation.id, headObservationId: headId, revisions: [learningObservation, next] });
    expect(result).toMatchObject({ draft: pending.draft, reason: pending.reason, expectedHead: headId, record: next, conflict: false });
    expect(observationRevisionCommand({ ...result, clientKey: "after-conflict" })).toMatchObject({ revisesObservationId: headId, expectedHead: headId, replacement: { answer: "my unsaved answer", courseId: pending.draft.courseId } });
  });

  it("separates conflicts, removed access, and recoverable request errors", () => {
    expect(observationRevisionFailure(new OpeningApiError(409, "head changed", "CONFLICT")).kind).toBe("conflict");
    expect(observationRevisionFailure(new OpeningApiError(404, "unavailable")).kind).toBe("unavailable");
    expect(observationRevisionFailure(new OpeningApiError(503, "database unavailable"))).toEqual({ kind: "error", message: "database unavailable" });
  });

  it("keeps tombstones reviewable without presenting them as current evidence", () => {
    const html = renderToStaticMarkup(createElement(ObservationRevisionCard, { record: { ...learningObservation, revisionKind: "retract" }, onChanged: () => undefined }));
    expect(html).toContain("已撤回 · 不计入当前证据");
    expect(html).toContain("查看历史");
    expect(html).toContain("纠正并重新纳入");
    expect(html).not.toContain(">撤回记录<");
  });

  it("keeps the latest loaded head when collapsing history after another tab corrected the record", () => {
    const corrected = { ...learningObservation, id: headId, rootObservationId: learningObservation.id, answer: "new answer from another tab", revisionKind: "replace" as const };
    const history = { rootObservationId: learningObservation.id, headObservationId: headId, revisions: [learningObservation, corrected] };
    const loaded = observationHistoryPanelReducer({ history: null, open: false }, { type: "loaded", history });
    const collapsed = observationHistoryPanelReducer(loaded, { type: "close" });
    expect(collapsed.open).toBe(false);
    expect(collapsed.history).toBe(history);
    const current = collapsed.history ? currentHistoryRecord(collapsed.history) : learningObservation;
    expect(current).toBe(corrected);
    expect(current.answer).toBe("new answer from another tab");
  });

  it.each([403, 404])("clears retained history when access is removed (%s)", (status) => {
    const history = { rootObservationId: learningObservation.id, headObservationId: learningObservation.id, revisions: [learningObservation] };
    const loaded = observationHistoryPanelReducer({ history: null, open: false }, { type: "loaded", history });
    expect(observationRevisionFailure(new OpeningApiError(status, "unavailable")).kind).toBe("unavailable");
    expect(observationHistoryPanelReducer(loaded, { type: "clear" })).toEqual({ history: null, open: false });
  });
});
