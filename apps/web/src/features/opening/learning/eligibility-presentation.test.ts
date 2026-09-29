import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { eligibilityReasonLabels } from "./eligibility-presentation";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { LearningAttemptForm } from "./attempt-form";
import type { LearningEvidenceEligibility } from "@aistudy/contracts";

const eligibility: LearningEvidenceEligibility = {
  independentAttempt: "unknown", verifiedCorrect: "unknown", usableForCurrentVersion: "unknown", usableForDelayedCheck: "unknown",
  reasonCodes: ["observation_identity_incomplete"], policyVersion: "opening-evidence-v1",
};

describe("learning eligibility presentation", () => {
  it("explains an incomplete legacy record without converting its status", () => {
    expect(eligibilityReasonLabels(eligibility)).toEqual(["缺少尝试、题目或当时版本，待核验"]);
    const html = renderToStaticMarkup(createElement(LearningEvidenceEligibilityDetails, { eligibility }));
    expect(html.match(/待核验/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("不代表系统客观判分");
  });
  it("distinguishes privacy exclusion from unavailable and changed content", () => {
    const labels = eligibilityReasonLabels({ ...eligibility, reasonCodes: ["version_privacy_excluded", "version_unavailable", "version_changed_needs_check"] });
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(["引用来源已被隐私排除", "引用来源或历史版本不可用", "材料或题目已变化，旧记录需复核"]);
  });
  it("keeps reference checking scope distinct from system grading", () => {
    const html = renderToStaticMarkup(createElement(LearningEvidenceEligibilityDetails, { eligibility: { ...eligibility, verifiedCorrect: "yes", reasonCodes: ["reference_checked_correct"] } }));
    expect(html).toContain("有依据的参考核验");
    expect(html).toContain("有记录的参考核对结果为正确");
    expect(html).toContain("不改变原始自报结果");
  });
  it("renders a start-first form with missing-material uncertainty", () => {
    const html = renderToStaticMarkup(createElement(LearningAttemptForm, { courseId: "11111111-1111-4111-8111-111111111111", onRecorded: () => undefined }));
    expect(html).toContain("开始本次练习");
    expect(html).toContain("不关联材料，保留为待核验记录");
    expect(html).not.toContain("保存自报结果");
  });
});

it("shows known unavailable source facts even when legacy eligibility remains unknown", () => {
  const html = renderToStaticMarkup(createElement(LearningEvidenceEligibilityDetails, { eligibility, versionApplicability: "unavailable" }));
  expect(html).toContain("来源或历史版本不可用");
  expect(html).toContain("待核验");
});
