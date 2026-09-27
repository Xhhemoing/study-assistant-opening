import { describe, expect, it } from "vitest";
import {
  activeConversation,
  initialPreviewState,
  recentReadyMaterial,
  selectableMaterialIds,
  visibleMaterials,
} from "./model";
import { advanceUpload, allMaterials, pickUploadName, selectMaterial } from "./material-actions";
import { allCourses, sendDraft, submitCourse } from "./chat-actions";
import { applyHash, hashFor, newConversation, openContinue, selectConversation, setScene } from "./session-actions";

describe("opening preview model", () => {
  it("offers one concrete continue context and no mastery metric", () => {
    const state = initialPreviewState();
    const ready = recentReadyMaterial(visibleMaterials(state.scene));
    expect(ready?.title).toContain("极限与连续");
    expect(JSON.stringify(state)).not.toMatch(/掌握|mastery|正确率/);
  });

  it("keeps the draft when a simulated send fails", () => {
    const failed = sendDraft({ ...initialPreviewState(), scene: "error", draft: "左右极限为什么要相等？" });
    expect(failed.sendPhase).toBe("failed");
    expect(failed.draft).toBe("左右极限为什么要相等？");
    expect(activeConversation(failed)?.messages).toHaveLength(2);
  });

  it("clears material and page when switching to a new conversation", () => {
    const next = newConversation(initialPreviewState(), "course-calc");
    const current = activeConversation(next);
    expect(current?.materialId).toBeNull();
    expect(current?.page).toBe("");
    expect(current?.courseId).toBe("course-calc");
    expect(next.draft).toBe("");
  });

  it("does not select processing or failed sample materials", () => {
    const state = initialPreviewState();
    const ids = selectableMaterialIds(visibleMaterials("normal"));
    expect(ids).toEqual(["calc-notes"]);
    const blocked = selectMaterial(state, "physics-lab");
    expect(activeConversation(blocked)?.materialId).toBe("calc-notes");
    expect(blocked.statusNote).toMatch(/只有已可阅读/);
  });

  it("drops the previous conversation context when another chat is selected", () => {
    const started = newConversation({ ...initialPreviewState(), draft: "先记下来" });
    const returned = selectConversation(started, "conv-limit");
    expect(activeConversation(returned)?.page).toBe("12");
    expect(returned.draft).toBe("先记下来");
  });

  it("continues into the assistant with the sample page context", () => {
    const next = openContinue(initialPreviewState());
    expect(next.view).toBe("assistant");
    expect(activeConversation(next)?.page).toBe("12");
  });

  it("stores only a picked file name and never requires file bytes", () => {
    const base = initialPreviewState();
    const picked = pickUploadName(base, "极限补充.pdf");
    const done = advanceUpload({ ...picked, uploadProgress: 90 });
    expect(done.uploadName).toBeNull();
    expect(allMaterials(done).some((item) => item.title === "极限补充.pdf")).toBe(true);
    expect(allMaterials(base)).toHaveLength(3);
    expect(allMaterials({ scene: "empty", extraMaterials: done.extraMaterials })).toEqual([]);
  });

  it("retains the course form when simulated save fails", () => {
    const state = {
      ...initialPreviewState(),
      scene: "error" as const,
      courseDraft: { title: "概率论", term: "2026 秋" },
    };
    const saved = submitCourse(state);
    expect(saved.courseError).toMatch(/模拟保存失败/);
    expect(saved.courseDraft.title).toBe("概率论");
    const created = submitCourse({ ...initialPreviewState(), courseDraft: { title: "概率论", term: "" } });
    expect(allCourses(created).some((item) => item.title === "概率论")).toBe(true);
    expect(allCourses(setScene(created, "empty"))).toEqual([]);
  });

  it("round-trips preview hash without leaving the preview views", () => {
    const detail = applyHash(initialPreviewState(), "#courses/detail/course-calc");
    expect(detail.view).toBe("courses");
    expect(hashFor(detail)).toBe("#courses/detail/course-calc");
    expect(applyHash(detail, "#nope").view).toBe("courses");
  });
});
