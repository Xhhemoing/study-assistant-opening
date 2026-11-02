#!/usr/bin/env -S node --import tsx
import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { courseRequirementProgressSchema, courseRequirementSchema, courseRouteSnapshotSchema } from "../packages/contracts/src/opening/course-route";
import { activitySpecSchema } from "../packages/contracts/src/opening/teaching-content";
import { uuidSchema } from "../packages/contracts/src/opening/foundation";
import type { createCourseAuditSample } from "./study-course-audit-sample";

const count = z.number().int().nonnegative().safe();
const identitySchema = z.object({
  courseId: uuidSchema, requirement: courseRequirementSchema,
  activityId: activitySpecSchema.shape.activityId, specId: activitySpecSchema.shape.id,
  teachingUnitId: activitySpecSchema.shape.teachingUnitId, contentVersion: activitySpecSchema.shape.version,
  documentId: activitySpecSchema.shape.documentId, revisionNumber: activitySpecSchema.shape.revisionNumber,
  questionBlockId: uuidSchema, answerBlockId: uuidSchema,
}).strict();
const groupSchema = z.object({ requirements: count, eligible: count, requirementsWithGaps: count }).strict();
const sampleSchema = z.object({
  format: z.literal("course-audit-pending-v1"), courseId: uuidSchema,
  scopeState: courseRouteSnapshotSchema.shape.scopeState, notice: z.string(),
  counts: z.object({ requirements: count, mandatory: count, optional: count, population: count, sampled: count.positive() }).strict(),
  mandatory: groupSchema, optional: groupSchema,
  requirements: z.array(courseRequirementProgressSchema.extend({ eligible: count, gaps: z.array(z.object({
    reason: z.enum(["source_unavailable", "unsaved_compilation", "missing_artifact", "empty_question", "missing_reference_answer", "no_questions"]),
    questionBlockId: uuidSchema.optional(),
  }).strict()) })),
  samplingFrame: z.array(identitySchema),
  samples: z.array(identitySchema.extend({ prompt: z.string().min(1), referenceAnswer: z.string().min(1),
    sourceRefs: activitySpecSchema.shape.sourceRefs, reviewStatus: z.literal("pending") })),
}).strict();
const reviewsSchema = z.object({ courseId: uuidSchema, results: z.array(z.object({
  identity: identitySchema, outcome: z.enum(["correct", "incorrect", "unjudgeable"]), note: z.string().optional(),
}).strict()) }).strict();
type Identity = z.infer<typeof identitySchema>;
// Explicit fields make JSON property order irrelevant while retaining the full requirement object.
export function courseAuditReviewIdentity(sample: Identity): Identity {
  return identitySchema.parse(Object.fromEntries(Object.keys(identitySchema.shape).map(key => [key, sample[key as keyof Identity]])));
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) throw new Error("Invalid local audit identity");
}
function requireEqual(actual: unknown, expected: unknown) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error("Invalid local audit binding");
}
export function createCourseAuditReview(rawSample: unknown, rawReviews: unknown) {
  const sample = sampleSchema.parse(rawSample) satisfies ReturnType<typeof createCourseAuditSample>;
  const reviews = reviewsSchema.parse(rawReviews);
  // Reject schema coercion/normalization at this exact-version file boundary.
  requireEqual(rawSample, sample);
  requireEqual(rawReviews, reviews);
  const rows = sample.requirements;
  for (const key of ["id", "stableSkillId", "requirementKey"] as const) unique(rows.map(row => row.requirement[key]));
  unique(rows.flatMap(row => row.compilation?.activityId ? [row.compilation.activityId] : []));
  const mandatory = rows.filter(row => row.requirement.mandatory).length;
  requireEqual(sample.counts, { requirements: rows.length, mandatory, optional: rows.length - mandatory,
    population: sample.samplingFrame.length, sampled: sample.samples.length });
  requireEqual(reviews.courseId, sample.courseId);
  for (const row of rows) requireEqual(row.requirement.courseId, sample.courseId);
  const questionKey = (item: Identity) => JSON.stringify([item.documentId, item.revisionNumber, item.questionBlockId]);
  const answerKey = (item: Identity) => JSON.stringify([item.documentId, item.revisionNumber, item.answerBlockId]);
  unique(sample.samplingFrame.map(questionKey));
  unique(sample.samplingFrame.map(answerKey));
  const frame = new Map(sample.samplingFrame.map(item => [questionKey(item), item]));
  const activityBindings = new Map<string, unknown>();
  for (const item of sample.samplingFrame) {
    requireEqual(item.courseId, sample.courseId);
    const row = rows.find(candidate => candidate.requirement.id === item.requirement.id);
    if (!row?.sourcesAvailable || !row.compilation?.saved || item.questionBlockId === item.answerBlockId
      || row.gaps.some(gap => ["source_unavailable", "unsaved_compilation", "missing_artifact", "no_questions"].includes(gap.reason)
        || gap.questionBlockId === item.questionBlockId)) throw new Error("Invalid local audit frame");
    requireEqual(item.requirement, row.requirement);
    requireEqual([item.activityId, item.contentVersion, item.documentId, item.revisionNumber],
      [row.compilation.activityId, row.compilation.contentVersion, row.compilation.documentId, row.compilation.revisionNumber]);
    const binding = [item.specId, item.teachingUnitId, item.contentVersion, item.documentId, item.revisionNumber];
    if (activityBindings.has(item.activityId)) requireEqual(binding, activityBindings.get(item.activityId));
    else activityBindings.set(item.activityId, binding);
  }
  for (const row of rows) requireEqual(row.eligible, sample.samplingFrame.filter(item => item.requirement.id === row.requirement.id).length);
  for (const flag of [true, false]) {
    const group = rows.filter(row => row.requirement.mandatory === flag);
    requireEqual(sample[flag ? "mandatory" : "optional"], { requirements: group.length,
      eligible: group.reduce((sum, row) => sum + row.eligible, 0), requirementsWithGaps: group.filter(row => row.gaps.length).length });
  }
  unique(sample.samples.map(questionKey));
  for (const item of sample.samples) requireEqual(courseAuditReviewIdentity(item), frame.get(questionKey(item)));
  const selected = new Map(sample.samples.map(item => [questionKey(item), courseAuditReviewIdentity(item)]));
  unique(reviews.results.map(result => questionKey(result.identity)));
  for (const result of reviews.results) requireEqual(result.identity, selected.get(questionKey(result.identity)));
  const byQuestion = new Map(reviews.results.map(result => [questionKey(result.identity), result]));
  const samples = sample.samples.map(item => {
    const review = byQuestion.get(questionKey(item));
    return { ...item, reviewStatus: review?.outcome ?? "pending", outcome: review?.outcome ?? "pending",
      ...(review?.note !== undefined ? { note: review.note } : {}) };
  });
  const summarize = (items: typeof samples) => {
    const correct = items.filter(item => item.outcome === "correct").length;
    const incorrect = items.filter(item => item.outcome === "incorrect").length;
    const unjudgeable = items.filter(item => item.outcome === "unjudgeable").length;
    const reviewed = correct + incorrect + unjudgeable;
    return { total: items.length, reviewed, pending: items.length - reviewed, correct, incorrect, unjudgeable };
  };
  return { ...sample, format: "course-audit-review-v1",
    notice: "人工输入汇总，不证明审查独立性、整课通过、发布资格；缺口和未审样本不计作正确。",
    reviewDefinition: "reviewed = correct + incorrect + unjudgeable; total = reviewed + pending. Counts describe the entire selected sample, not the whole course.",
    reviewCounts: { all: summarize(samples), mandatory: summarize(samples.filter(item => item.requirement.mandatory)),
      optional: summarize(samples.filter(item => !item.requirement.mandatory)) }, samples };
}

export async function runCourseAuditReview(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`Usage: node --import tsx scripts/study-course-audit-review.ts --sample FILE --reviews FILE --output NEW_FILE
Read only the two explicit local JSON files. Sample: course-audit-pending-v1, unchanged sampler output.
Reviews: {courseId,results:[{identity,outcome:'correct'|'incorrect'|'unjudgeable',note?:string}]}.
Copy identity fields exactly from the sample: courseId, full requirement, activityId, specId, teachingUnitId,
contentVersion, documentId, revisionNumber, questionBlockId, answerBlockId. No extra authority fields.
Partial reviews leave pending samples; reviewed = correct + incorrect + unjudgeable. All denominators and gaps remain.
Output is a NEW private (0600) file; no overwrites, database, network, model calls or automatic verification.
Human input does not establish independence, whole-course correctness or release eligibility. No private content is printed.`);
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--sample", "--reviews", "--output"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid options");
    options.set(key, value);
  }
  const sample = options.get("--sample"), reviews = options.get("--reviews"), output = options.get("--output");
  if (!sample || !reviews || !output || [sample, reviews].some(input => resolve(input) === resolve(output))) throw new Error("Invalid options");
  const report = createCourseAuditReview(JSON.parse(await readFile(sample, "utf8")), JSON.parse(await readFile(reviews, "utf8")));
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8");
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(output);
    throw error;
  }
  const counts = report.reviewCounts.all;
  console.log(`Sampled: ${counts.total}; reviewed: ${counts.reviewed}; pending: ${counts.pending}; correct: ${counts.correct}; incorrect: ${counts.incorrect}; unjudgeable: ${counts.unjudgeable}; output: ${output}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCourseAuditReview(process.argv.slice(2)).catch(() => {
    console.error("Course audit review failed: check local files, exact sample identities and new output path; use --help.");
    process.exitCode = 1;
  });
}
