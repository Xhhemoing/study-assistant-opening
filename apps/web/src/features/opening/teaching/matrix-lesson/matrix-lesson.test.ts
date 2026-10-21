import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyMap } from "@aistudy/domain";
import { CHALLENGE_MATRIX, CHALLENGE_VECTOR, MATRIX_LESSON_REQUIREMENT, PLANE_PRESETS, matrixLessonPracticeStatus, planeDecomposition, transformPlaneVector } from "./lesson-model";
import { initialMatrixLessonProgress, readMatrixLessonProgress, recordMatrixLessonOriginal, revealMatrixLessonHint, saveMatrixLessonProgress, visitMatrixLessonSection } from "./lesson-progress";
import { MatrixPlaneDiagram, MatrixPlaneExplorer } from "./matrix-plane";
import { MatrixConceptLesson } from "./matrix-concept-lesson";
const appearance = vi.hoisted(() => ({ motion: "system" as "system" | "reduce" }));
vi.mock("../../settings/appearance-preferences", () => ({ useAppearancePreferences: () => ({ preferences: appearance }) }));

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
function createStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("matrix concept lesson mathematics", () => {
  it("disables automatic play for the explicit reduce-motion preference", () => {
    appearance.motion = "reduce";
    const html = renderToStaticMarkup(createElement(MatrixPlaneExplorer, { interactiveEnabled: true }));
    expect(html).toContain("已按减少动态偏好关闭播放");
    expect(html).toMatch(/disabled="" aria-pressed="false"/);
    appearance.motion = "system";
  });
  it("uses the domain transform for each preset and adds column contributions to the same result", () => {
    for (const { matrix } of PLANE_PRESETS) {
      for (const vector of [[2, -1], [-1, 2], [0, 0]] as const) {
        const { first, second, result } = planeDecomposition(matrix, vector);
        expect(result).toEqual([first[0] + second[0], first[1] + second[1]]);
        expect(applyMap(matrix.map(row => [...row]), [...vector])).toEqual({ ok: true, y: [...result] });
      }
    }
    expect(transformPlaneVector(CHALLENGE_MATRIX, CHALLENGE_VECTOR)).toEqual([1, 4]);
  });
  it("shows only the original vector before the learner retains their own thinking", () => {
    const html = renderToStaticMarkup(createElement(MatrixPlaneDiagram, { matrix: CHALLENGE_MATRIX, vector: CHALLENGE_VECTOR, originalOnly: true }));
    expect(html).toContain("变换结果保留到你提交思考之后");
    expect(html).not.toContain("x·第1列");
    expect(html).not.toContain(">Av<");
    expect(html).not.toContain("相加得到 Av");
  });
  it("retains the diagram and arithmetic with no interactive controls when the real gate is off", () => {
    const html = renderToStaticMarkup(createElement(MatrixPlaneExplorer, { interactiveEnabled: false }));
    expect(html).toContain("当前工作区关闭了交互图示");
    expect(html).toContain("<svg");
    expect(html).toContain("Av =");
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("播放四步");
  });
});

describe("lesson original-answer and help history", () => {
  it("requires an original attempt before feedback and preserves its exact text and help at the time", () => {
    const start = initialMatrixLessonProgress();
    expect(visitMatrixLessonSection(start, 4).section).toBe(2);
    expect(recordMatrixLessonOriginal(start)).toBe(start);
    const saved = recordMatrixLessonOriginal({ ...start, draftAnswer: "  (1,4)\n两列取2份和1份。  " });
    expect(saved.original).toEqual({ answer: "  (1,4)\n两列取2份和1份。  ", assistance: "independent" });
    expect(saved.solutionSeen).toBe(true);
    expect(saved.section).toBe(3);
    const attemptedRewrite = recordMatrixLessonOriginal({ ...saved, draftAnswer: "看完答案后的新表述", assistance: "revealed" });
    expect(attemptedRewrite.original).toEqual(saved.original);
    expect(visitMatrixLessonSection(saved, 4).section).toBe(4);
  });
  it("retains assistance and cannot turn a hinted or skipped answer into a fresh independent answer", () => {
    const hinted = revealMatrixLessonHint({ ...initialMatrixLessonProgress(), draftAnswer: "我不确定" });
    expect(recordMatrixLessonOriginal({ ...hinted, assistance: "independent" }).original?.assistance).toBe("hinted");
    const skipped = recordMatrixLessonOriginal(initialMatrixLessonProgress(), true);
    expect(skipped.original).toEqual({ answer: "暂时不会，先看讲解", assistance: "revealed" });
    expect(recordMatrixLessonOriginal({ ...skipped, assistance: "independent" }).original?.assistance).toBe("revealed");
  });
  it("restores exact thinking and viewed help, scoped to course and lesson revision", () => {
    const storage = createStorage();
    const progress = recordMatrixLessonOriginal(revealMatrixLessonHint({ ...initialMatrixLessonProgress(), draftAnswer: "我的第一反应" }));
    expect(saveMatrixLessonProgress(id, progress, storage)).toBe(true);
    expect(readMatrixLessonProgress(id, storage)).toEqual(progress);
    expect(readMatrixLessonProgress(otherId, storage)).toEqual(initialMatrixLessonProgress());
    const key = [...storage.values.keys()][0]!;
    storage.values.set(key, JSON.stringify({ courseId: id, version: 2, progress }));
    expect(readMatrixLessonProgress(id, storage)).toEqual(initialMatrixLessonProgress());
  });
  it("rejects malformed states, injected assessment facts, feedback without an original, and cross-course notes", () => {
    const storage = createStorage();
    const key = `study:matrix-concept:v1:${id}`;
    for (const value of ["{", JSON.stringify({ courseId: otherId, version: 1, progress: initialMatrixLessonProgress() }), JSON.stringify({ courseId: id, version: 1, progress: { ...initialMatrixLessonProgress(), section: 4 } }), JSON.stringify({ courseId: id, version: 1, progress: { ...initialMatrixLessonProgress(), mastery: true } }), JSON.stringify({ courseId: id, version: 1, progress: { ...initialMatrixLessonProgress(), draftAnswer: "x".repeat(4001) } })]) {
      storage.values.set(key, value);
      expect(readMatrixLessonProgress(id, storage)).toEqual(initialMatrixLessonProgress());
    }
  });
  it("keeps the newest in-memory note after quota failure rather than restoring a stale storage value", async () => {
    vi.resetModules();
    const { readMatrixLessonProgress: read, saveMatrixLessonProgress: save } = await import("./lesson-progress");
    const storage = createStorage();
    const first = { ...initialMatrixLessonProgress(), draftAnswer: "先前答案" };
    expect(save(id, first, storage)).toBe(true);
    const latest = { ...first, draftAnswer: "不能丢失的新答案" };
    storage.setItem = () => { throw new Error("quota"); };
    expect(save(id, latest, storage)).toBe(false);
    expect(read(id, storage)).toEqual(latest);
  });
});

describe("honest lesson summary", () => {
  it("reports only the matching real requirement and never infers mastery from reading", () => {
    const row = { skillLabel: "矩阵乘法", status: "observed_independent" as const, evidenceIds: [id], sampleCount: 2, lastObservedAt: null, requirementKey: MATRIX_LESSON_REQUIREMENT };
    expect(matrixLessonPracticeStatus([{ ...row, requirementKey: "another-requirement" }])).toContain("尚未读到");
    expect(matrixLessonPracticeStatus([row])).toContain("仍不等于稳固掌握或已完成延迟复测");
    expect(matrixLessonPracticeStatus([{ ...row, status: "needs_review" }])).toContain("待复查");
  });
  it("offers a coherent initial lesson without making any API writes or exposing the challenge solution", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = renderToStaticMarkup(createElement(MatrixConceptLesson, { courseId: id, courseTitle: "线性代数", practiceHref: "/practice", delayedPracticeHref: "/delayed", interactiveEnabled: false, matrixPracticeEnabled: false }));
    expect(html).toContain("矩阵怎样变换平面向量");
    expect(html).toContain("返回课程");
    expect(html).toContain("先看蓝色原箭头");
    expect(html).not.toContain("本题解析已经看过");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
