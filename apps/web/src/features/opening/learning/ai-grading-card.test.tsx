import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AiEvaluation, LearningObservation, SourceRecord } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { AiGradingCard, AiGradingResult, aiGradingRequest, canGradeObservation } from "./ai-grading-card";
import { AiGradingPhotoFields, emptyGradingPhoto, gradingPhotoSources } from "./ai-grading-photo";
import { ObservationRevisionCard } from "./observation-revision-card";

const attemptId = "22222222-2222-4222-8222-222222222222";
const evaluation: AiEvaluation = {
  observationId: learningObservation.id, attemptId, problemId: learningObservation.problemId!,
  itemVersionId: "88888888-8888-4888-8888-888888888888", requirementKey: null,
  evaluatorVersion: "ai-rubric-v1", modelLabel: "test-model", evaluatedAt: "2026-10-21T12:00:00.000Z",
  outcome: "correct", confidence: 0.91, questionMatch: true, feedback: "列式与计算正确。",
  criteria: [{ label: "列式", verdict: "correct", feedback: "两个系数都对应原向量。" }],
};
const record: LearningObservation = { ...learningObservation, answer: "我的原答案 <x>\n  不覆盖空格", attemptId, itemVersionId: evaluation.itemVersionId, verdictSource: "ai_graded", aiEvaluation: evaluation };
it("renders necessary proof steps and the smallest repair without inventing a positive total",()=>{
  const html=renderToStaticMarkup(createElement(AiGradingResult,{record:{...record,outcome:"unverified",aiEvaluation:{...evaluation,outcome:"unverified",proofFeedback:{coverage:"partial",steps:[
    {stepIndex:2,claim:"A²v=λv",required:true,verdict:"unverified",feedback:"少一次代入",repairPrompt:"先写A(λv)"}]}}}}));
  expect(html).toContain("证明步骤核对");expect(html).toContain("必要步骤");expect(html).toContain("尚有步骤未核对");expect(html).toContain("先写A(λv)");
  expect(html).not.toContain("AI 批改 · 正确");
});

it("shows the effective uncertain verdict even when the raw model proposed correct", () => {
  const html = renderToStaticMarkup(createElement(AiGradingResult, { record: { ...record, outcome: "unverified", aiEvaluation: { ...evaluation, confidence: 0.4 } } }));
  expect(html).toContain("AI 批改 · 暂不能判断");
  expect(html).not.toContain("AI 批改 · 正确");
  expect(html).toContain("评分要点");
  expect(html).not.toContain("批改详情");
  expect(html).not.toContain("自评置信度");
});

it.each([record, { ...record, aiEvaluation: null, verdictSource: "self_report" as const, revisionKind: "replace" as const }])("uses one explicit finish link for a reliable or known corrected photo result", observation => {
  const html = renderToStaticMarkup(createElement(AiGradingCard, { record: observation, onGraded() {}, completionAction: { label: "结束练习", href: "/opening/today" } }));
  expect(html.match(/href="\/opening\/today"/g)).toHaveLength(1);
  expect(html).toContain("结束练习");
  const uncertain = renderToStaticMarkup(createElement(AiGradingCard, { record: { ...observation, outcome: "unverified" }, onGraded() {}, completionAction: { label: "结束练习", href: "/opening/today" } }));
  expect(uncertain).not.toContain("结束练习");
});

it("keeps photo transcription separate from the original answer and offers dispute correction", () => {
  const graded = { ...record, aiEvaluation: { ...evaluation, transcription: "图片识别出的答案" } };
  const html = renderToStaticMarkup(createElement(ObservationRevisionCard, { record: graded, onChanged() {} }));
  expect(html).toContain("我的原答案 &lt;x&gt;\n  不覆盖空格");
  expect(html).toContain("查看图片识别文字");
  expect(html).toContain("图片识别出的答案");
  expect(html).toContain("判错了");
  expect(html).not.toContain("自动核算正确");
  expect(graded.answer).toBe(record.answer);
});

it("renders feedback formulas safely while preserving the raw answer and OCR as literal text", () => {
  const graded = { ...record, answer: "原答 $x^2$ <script>original</script>", aiEvaluation: { ...evaluation,
    feedback: "由 $x^2=4$ 可得答案。<script>alert(1)</script>",
    criteria: [{ label: "计算", verdict: "correct" as const, feedback: "结果为 $\\frac{1}{2}$。<img src=x onerror=alert(1)>" }],
    transcription: "OCR $x^2$ <script>scan</script>",
  } };
  const html = renderToStaticMarkup(createElement(ObservationRevisionCard, { record: graded, onChanged() {} }));
  expect(html.match(/class="katex"/g)).toHaveLength(2);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("onerror=");
  expect(html).toContain("原答 $x^2$ &lt;script&gt;original&lt;/script&gt;");
  expect(html).toContain("OCR $x^2$ &lt;script&gt;scan&lt;/script&gt;");
});

it("allows grading an existing source-bound answer but excludes missing identity and retractions", () => {
  const saved = { ...record, aiEvaluation: null, verdictSource: "self_report" as const };
  expect(canGradeObservation(saved)).toBe(true);
  expect(canGradeObservation({ ...saved, attemptId: null })).toBe(false);
  expect(canGradeObservation({ ...saved, problemId: null })).toBe(false);
  expect(canGradeObservation({ ...saved, itemVersionId: null })).toBe(false);
  expect(canGradeObservation({ ...saved, revisionKind: "retract" })).toBe(false);
  const html = renderToStaticMarkup(createElement(AiGradingCard, { record: saved, onGraded() {} }));
  expect(html).toContain("正在读取后台批改状态");
  expect(html).not.toContain("添加作答照片");
});

it("submits only the saved observation identity and exact selected photo, never rewritten answer text", () => {
  expect(aiGradingRequest(record.id, emptyGradingPhoto)).toEqual({ observationId: record.id });
  const photo = { workSourceId: "99999999-9999-4999-8999-999999999999", workSourceVersion: 4, physicalPage: 2 };
  expect(aiGradingRequest(record.id, photo)).toEqual({ observationId: record.id, ...photo });
  const html = renderToStaticMarkup(createElement(AiGradingCard, { record, photo, onGraded() {} }));
  expect(html).not.toContain("version=4&amp;page=2");
  expect(html).not.toContain("查看作答照片");
});

it("reopens the assessed photo version from saved history even when the current draft selected another version", () => {
  const workSource = { id: "99999999-9999-4999-8999-999999999999", version: 2, physicalPage: 3 };
  const graded = { ...record, aiEvaluation: { ...evaluation, workSource } };
  const html = renderToStaticMarkup(createElement(AiGradingCard, { record: graded, photo: { workSourceId: workSource.id, workSourceVersion: 9, physicalPage: 1 }, onGraded() {} }));
  expect(html).toContain("查看作答照片");
  expect(html).toContain("version=2&amp;page=3");
  expect(html).not.toContain("version=9");
});

function source(changes: Partial<SourceRecord> = {}): SourceRecord {
  return { id: "99999999-9999-4999-8999-999999999999", workspaceId: record.workspaceId, name: "手写作答.png", mime: "image/png", bytes: 100, sha256: "a".repeat(64), version: 1, uploadState: "uploaded", parseState: "not_started", error: null, createdAt: "2026-10-21T12:00:00.000Z", ...changes };
}

it("offers uploaded photos before parsing, but rejects incomplete uploads and unparsed PDFs", () => {
  const photo = source(), pdf = source({ id: "88888888-8888-4888-8888-888888888888", mime: "application/pdf", parseState: "ready" });
  expect(gradingPhotoSources([photo, source({ uploadState: "pending" }), source({ mime: "audio/mpeg" }), source({ mime: "application/pdf" }), pdf])).toEqual([photo, pdf]);
  const html = renderToStaticMarkup(createElement(AiGradingPhotoFields, { sources: [photo], value: emptyGradingPhoto, onChange() {} }));
  expect(html).toContain("手写作答.png");
  expect(html).toContain("上传作答照片");
});

it("does not silently replace the selected photo version after the material changes", () => {
  const html = renderToStaticMarkup(createElement(AiGradingPhotoFields, { sources: [source({ version: 2 })], value: { workSourceId: source().id, workSourceVersion: 1, physicalPage: 1 }, onChange() {} }));
  expect(html).toContain('value="unavailable" selected=""');
  expect(html).toContain("原选文件暂不可用");
});
