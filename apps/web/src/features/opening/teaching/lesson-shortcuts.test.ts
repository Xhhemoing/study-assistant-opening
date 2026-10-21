import { expect, it } from "vitest";
import { lessonArrowDirection } from "./lesson-shortcuts";
const event = { key: "ArrowRight", defaultPrevented: false, isComposing: false, keyCode: 39, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const guard = { editing: false, selection: false, hidden: false, modal: false, withinLesson: true, busy: false, previous: true, next: true };
it("uses only the current lesson's available navigation actions", () => {
  expect(lessonArrowDirection(event, guard)).toBe(1);
  expect(lessonArrowDirection({ ...event, key: "ArrowLeft" }, guard)).toBe(-1);
  expect(lessonArrowDirection(event, { ...guard, next: false })).toBeNull();
  expect(lessonArrowDirection({ ...event, key: "ArrowLeft" }, { ...guard, next: false })).toBe(-1);
  expect(lessonArrowDirection({ ...event, key: "ArrowLeft" }, { ...guard, previous: false })).toBeNull();
});
it.each(["defaultPrevented", "isComposing", "repeat", "altKey", "ctrlKey", "metaKey", "shiftKey"] as const)("does not intercept an event with %s", key => {
  expect(lessonArrowDirection({ ...event, [key]: true }, guard)).toBeNull();
});
it.each(["editing", "selection", "hidden", "modal", "busy"] as const)("does not change lesson position while %s", key => {
  expect(lessonArrowDirection(event, { ...guard, [key]: true })).toBeNull();
});
it("leaves IME keyCode 229, another surface, and non-arrow keys alone", () => {
  expect(lessonArrowDirection({ ...event, keyCode: 229 }, guard)).toBeNull();
  expect(lessonArrowDirection(event, { ...guard, withinLesson: false })).toBeNull();
  expect(lessonArrowDirection({ ...event, key: "Enter" }, guard)).toBeNull();
});
