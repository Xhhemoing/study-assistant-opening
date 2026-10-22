import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { ObservationRevisionCard } from "../learning/observation-revision-card";
import { CreateCardDialog } from "./create-card-dialog";

it("prefills a wrong-answer card with editable question/reference and course/skill attribution", () => {
  const html = renderToStaticMarkup(createElement(CreateCardDialog, { initial: {
    observationId: learningObservation.id, front: "What is a derivative?", back: "Reference: a limit.", courseId: learningObservation.courseId, skillLabel: "derivatives",
  }, onClose() {} }));
  expect(html).toContain("What is a derivative?");
  expect(html).toContain("Reference: a limit.");
  expect(html).toContain(`value="${learningObservation.courseId}"`);
  expect(html).toContain('value="derivatives"');
  expect(html).toContain("加入卡组");
  expect(html).toContain("题目会换一道新变式来复习");
  expect(html).toContain('value="question" selected=""');
});

it("offers card creation only for a current incorrect observation, without creating before confirmation", () => {
  const render = (outcome: "correct" | "incorrect", revisionKind: "original" | "retract" = "original") => renderToStaticMarkup(createElement(ObservationRevisionCard,
    { record: { ...learningObservation, outcome, revisionKind }, onChanged() {} }));
  expect(render("incorrect")).toContain("做成记忆卡片");
  expect(render("correct")).not.toContain("做成记忆卡片");
  expect(render("incorrect", "retract")).not.toContain("做成记忆卡片");
  expect(render("incorrect")).not.toContain("加入卡组");
});
