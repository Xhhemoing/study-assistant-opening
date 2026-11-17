import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivitySpecClientInit } from "@aistudy/contracts";
import { CourseHandoutReader } from "./course-handout-reader";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const id = "11111111-1111-4111-8111-111111111111";
const conversation = "66666666-6666-4666-8666-666666666666";

const init: ActivitySpecClientInit = {
  id,
  activityId: id,
  teachingUnitId: id,
  documentId: id,
  revisionNumber: 1,
  blockOrder: [],
  sourceRefs: [],
  goals: [],
  verificationStatus: "needs_check",
  generationConfig: {},
  version: 1,
  contentVersion: 1,
  blocks: [],
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
};

describe("CourseHandoutReader", () => {
  it("preserves a valid originalConversationId on the back-to-course link", () => {
    const html = renderToStaticMarkup(
      createElement(CourseHandoutReader, {
        courseId,
        init,
        generateStatus: "ready",
        originalConversationId: conversation,
      }),
    );
    expect(html).toContain(`href="/opening/courses/${courseId}?tab=units&amp;conversation=${conversation}"`);
  });

  it("omits conversation parameter when missing or malformed", () => {
    for (const originalConversationId of [undefined, null, "not-a-uuid"]) {
      const html = renderToStaticMarkup(
        createElement(CourseHandoutReader, {
          courseId,
          init,
          generateStatus: "needs_check",
          originalConversationId,
        }),
      );
      expect(html).toContain(`href="/opening/courses/${courseId}?tab=units"`);
      expect(html).not.toContain("conversation=");
    }
  });
});
