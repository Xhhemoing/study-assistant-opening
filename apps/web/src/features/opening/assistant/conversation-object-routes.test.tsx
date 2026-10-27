import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ redirect: vi.fn(), read: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (href: string) => { calls.redirect(href); throw new Error("redirect"); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../runtime", () => ({ requireOpeningScope: async () => ({ scope: {}, sql: {} }) }));
vi.mock("../exam-sprint/course-exam-runtime", () => ({ getCourseExamService: () => ({ read: calls.read }) }));
import CoursePage from "../../../app/(opening)/opening/courses/[id]/page";
import ReviewPage from "../../../app/(opening)/opening/review/page";
import SprintPage from "../../../app/(opening)/opening/sprint/page";
import CardsPage from "../../../app/(opening)/opening/cards/page";
import NotePage from "../../../app/(opening)/opening/library/[id]/page";
import ExamPage from "../../../app/(opening)/opening/courses/[id]/exam/page";
import { ConversationObjectFrame } from "./conversation-object-frame";
import { CourseDetail } from "../courses/course-detail";

const conversation = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";
function frame(node: unknown) {
  expect(isValidElement(node)).toBe(true);
  const element = node as ReactElement<{ conversation?: string; children: ReactElement<{ conversationId?: string }> }>;
  expect(element.type).toBe(ConversationObjectFrame); return element;
}
beforeEach(() => { calls.redirect.mockReset(); calls.read.mockReset().mockResolvedValue({ courseId }); });
it("adds one route-level frame to course detail, review/card destination and exam only for the explicit reference", async () => {
  const course = frame(await CoursePage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ conversation }) }));
  expect(course.props.conversation).toBe(conversation); expect(course.props.children.props.conversationId).toBe(conversation);
  const sprint = frame(await CoursePage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ mode: "sprint", conversation }) }));
  expect(sprint.props.conversation).toBe(conversation);
  expect(frame(await ReviewPage({ searchParams: Promise.resolve({ tab: "cards", conversation }) })).props.conversation).toBe(conversation);
  expect(frame(await ExamPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ conversation }) })).props.conversation).toBe(conversation);
  expect(calls.read).toHaveBeenCalledWith({}, courseId);
  expect(frame(await CoursePage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({}) })).props.conversation).toBeUndefined();
});
it("keeps the conversation when cards redirect and the canonical sprint renders its course", async () => {
  await expect(CardsPage({ searchParams: Promise.resolve({ conversation, cardId: "original-card" }) })).rejects.toThrow("redirect");
  const cards = new URL(calls.redirect.mock.lastCall![0], "https://study.test");
  expect(cards.pathname).toBe("/opening/review"); expect(cards.searchParams.get("conversation")).toBe(conversation); expect(cards.searchParams.get("cardId")).toBe("original-card");
  calls.redirect.mockClear();
  const sprint = frame(await SprintPage({ searchParams: Promise.resolve({ conversation, courseId, source: "source", version: "3" }) }));
  expect(sprint.props.conversation).toBe(conversation);
  expect(sprint.props.children.type).toBe(CourseDetail);
  expect(sprint.props.children.props).toEqual({ id: courseId, mode: "sprint", conversationId: conversation });
  expect(calls.redirect).not.toHaveBeenCalled();
  expect(frame(await SprintPage({ searchParams: Promise.resolve({ conversation }) })).props.conversation).toBe(conversation);
});
it("does not pass a malformed conversation into the course's continuation links", async () => {
  const course = frame(await CoursePage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ conversation: "invalid" }) }));
  expect(course.props.conversation).toBe("invalid"); expect(course.props.children.props.conversationId).toBeUndefined();
});

it("carries only an explicit note conversation while preserving the document identity and permission-owning editor", async () => {
  const noteId = "33333333-3333-4333-8333-333333333333";
  const { DocumentEditor } = await import("../editor/document-editor");
  const known = frame(await NotePage({ params: Promise.resolve({ id: noteId }), searchParams: Promise.resolve({ conversation }) }));
  expect(known.props.conversation).toBe(conversation);
  expect(known.props.children.type).toBe(DocumentEditor);
  expect(known.props.children.props).toEqual({ documentId: noteId, basePath: "/opening/library" });
  expect(frame(await NotePage({ params: Promise.resolve({ id: noteId }), searchParams: Promise.resolve({}) })).props.conversation).toBeUndefined();
});
it.each(["invalid", [conversation, conversation]])("lets the shared frame reject a malformed or repeated note conversation without rebinding the editor: %j", async value => {
  const noteId = "33333333-3333-4333-8333-333333333333";
  const note = frame(await NotePage({ params: Promise.resolve({ id: noteId }), searchParams: Promise.resolve({ conversation: value }) }));
  expect(note.props.conversation).toEqual(value);
  expect(note.props.children.props).toEqual({ documentId: noteId, basePath: "/opening/library" });
  const rejected = ConversationObjectFrame({ conversation: value, children: note.props.children });
  expect(rejected).not.toBe(note.props.children);
  expect(JSON.stringify(rejected)).toContain("原对话链接无效");
});
