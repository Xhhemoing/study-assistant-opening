#!/usr/bin/env -S node --import tsx
import { randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { courseRouteSnapshotSchema } from "../packages/contracts/src/opening/course-route";
import { activitySpecSchema } from "../packages/contracts/src/opening/teaching-content";
import { uuidSchema } from "../packages/contracts/src/opening/foundation";
import { teachingQuestionText } from "../packages/database/src/repositories/opening-teaching-question";

// Private file boundary, not a new product contract. No database connection is created.
const inputSchema = z.object({
  snapshot: courseRouteSnapshotSchema,
  artifacts: z.array(z.object({
    spec: activitySpecSchema,
    revision: z.object({
      documentId: uuidSchema,
      revisionNumber: z.number().int().positive().safe(),
      blocks: z.array(z.object({
        id: uuidSchema, type: z.string().min(1).max(120),
        position: z.number().int().nonnegative().safe().optional(),
        content: z.record(z.string(), z.unknown()),
      }).strict()),
    }).strict(),
  }).strict()),
}).strict();

function unique(values: readonly (string | number)[]) {
  if (new Set(values).size !== values.length) throw new Error("Ambiguous identity");
}

export function createCourseAuditSample(raw: unknown, sampleSize: number) {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1) throw new Error("Invalid sample size");
  const { snapshot, artifacts } = inputSchema.parse(raw);
  const rows = snapshot.requirements;
  for (const key of ["id", "stableSkillId", "requirementKey"] as const) unique(rows.map(row => row.requirement[key]));
  unique(rows.flatMap(row => row.compilation?.activityId ? [row.compilation.activityId] : []));
  const mandatory = rows.filter(row => row.requirement.mandatory).length;
  if (rows.some(row => row.requirement.courseId !== snapshot.courseId)
    || snapshot.summary.total !== rows.length || snapshot.summary.mandatory !== mandatory) throw new Error("Invalid course manifest");
  unique(artifacts.map(artifact => artifact.spec.activityId));
  const byActivity = new Map(artifacts.map(artifact => [artifact.spec.activityId, artifact]));
  for (const { spec, revision } of artifacts) {
    const compilation = rows.find(row => row.compilation?.activityId === spec.activityId)?.compilation;
    if (!compilation?.saved || spec.documentId !== compilation.documentId || spec.revisionNumber !== compilation.revisionNumber
      || spec.version !== compilation.contentVersion || revision.documentId !== spec.documentId
      || revision.revisionNumber !== spec.revisionNumber) throw new Error("Artifact version mismatch");
    unique(revision.blocks.map(block => block.id));
    unique(spec.blockOrder.map(block => block.blockId));
    unique(spec.blockOrder.map(block => block.position));
    for (const ref of spec.blockOrder) {
      const block = revision.blocks.find(candidate => candidate.id === ref.blockId);
      if (!block || block.type !== ref.blockType) throw new Error("Pinned block mismatch");
    }
  }
  type Gap = { reason: string; questionBlockId?: string };
  type Identity = {
    courseId: string; requirement: (typeof rows)[number]["requirement"];
    activityId: string; specId: string; teachingUnitId: string; contentVersion: number;
    documentId: string; revisionNumber: number; questionBlockId: string; answerBlockId: string;
  };
  type Sample = Identity & {
    prompt: string; referenceAnswer: string; sourceRefs: (typeof artifacts)[number]["spec"]["sourceRefs"];
    reviewStatus: "pending";
  };
  const population: Sample[] = [];
  const requirements = rows.map(row => {
    const gaps: Gap[] = [];
    const start = population.length;
    const compilation = row.compilation;
    const artifact = compilation?.activityId ? byActivity.get(compilation.activityId) : undefined;
    if (!row.sourcesAvailable) gaps.push({ reason: "source_unavailable" });
    if (!compilation?.saved) gaps.push({ reason: "unsaved_compilation" });
    else if (!artifact) gaps.push({ reason: "missing_artifact" });
    if (row.sourcesAvailable && compilation?.saved && artifact) {
      const { spec, revision } = artifact;
      const ordered = [...spec.blockOrder].sort((a, b) => a.position - b.position);
      let questions = 0;
      for (const [index, ref] of ordered.entries()) {
        if (ref.role === "answer_key" || !(ref.role === "prompt" || ["prompt", "question"].includes(ref.blockType))
          || !["prompt", "question"].includes(ref.blockType)) continue;
        const block = revision.blocks.find(candidate => candidate.id === ref.blockId)!;
        const prompt = teachingQuestionText(block.content);
        if (!prompt) { gaps.push({ reason: "empty_question", questionBlockId: ref.blockId }); continue; }
        questions++;
        const next = ordered[index + 1];
        const answer = next && (next.role === "answer_key" || ["answer_key", "solution"].includes(next.blockType))
          ? revision.blocks.find(candidate => candidate.id === next.blockId && ["answer_key", "solution"].includes(candidate.type)) : undefined;
        const referenceAnswer = teachingQuestionText(answer?.content);
        if (!answer || !referenceAnswer) { gaps.push({ reason: "missing_reference_answer", questionBlockId: ref.blockId }); continue; }
        population.push({ courseId: snapshot.courseId, requirement: row.requirement,
          activityId: spec.activityId, specId: spec.id, teachingUnitId: spec.teachingUnitId, contentVersion: spec.version,
          documentId: spec.documentId, revisionNumber: spec.revisionNumber, questionBlockId: ref.blockId,
          answerBlockId: answer.id, prompt, referenceAnswer, sourceRefs: spec.sourceRefs, reviewStatus: "pending" });
      }
      if (!questions) gaps.push({ reason: "no_questions" });
    }
    return { ...row, eligible: population.length - start, gaps };
  });
  if (sampleSize > population.length) throw new Error("Sample size exceeds population");
  const samplingFrame = population.map(({ prompt: _prompt, referenceAnswer: _answer, sourceRefs: _refs, reviewStatus: _status, ...identity }) => identity);
  const shuffled = [...population];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const summarize = (mandatoryFlag: boolean) => {
    const group = requirements.filter(row => row.requirement.mandatory === mandatoryFlag);
    return { requirements: group.length, eligible: group.reduce((sum, row) => sum + row.eligible, 0),
      requirementsWithGaps: group.filter(row => row.gaps.length > 0).length };
  };
  return {
    format: "course-audit-pending-v1", courseId: snapshot.courseId, scopeState: snapshot.scopeState,
    notice: "待人工审查（pending）；不是随机金标、全课通过结论或发布资格。缺口不计作零错误。",
    counts: { requirements: rows.length, mandatory, optional: rows.length - mandatory, population: population.length, sampled: sampleSize },
    mandatory: summarize(true), optional: summarize(false), requirements, samplingFrame, samples: shuffled.slice(0, sampleSize),
  };
}

export async function runCourseAuditSample(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`Usage: node --import tsx scripts/study-course-audit-sample.ts --input FILE --sample-size N --output NEW_FILE
Read an explicitly provided local JSON file only: {snapshot, artifacts:[{spec, revision:{documentId, revisionNumber, blocks:[{id,type,position?,content}]}}]}.
Use the existing courseRouteSnapshotSchema and current activitySpecSchema; include the full requirement manifest.
Each artifact must match a saved compilation's activityId/documentId/revisionNumber/contentVersion.
Missing artifacts, sources or reference answers remain visible gaps. N must be a positive safe integer no larger than the population.
Output is a NEW private (0600) file, with current-version identities and pending human review; never overwrite existing files.
No database collection, provider calls, quality verdict or release qualification. No question/answer text is printed.`);
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--input", "--sample-size", "--output"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid options");
    options.set(key, value);
  }
  const input = options.get("--input"), output = options.get("--output"), size = options.get("--sample-size");
  if (!input || !output || !size || !/^[1-9]\d*$/.test(size) || resolve(input) === resolve(output)) throw new Error("Invalid options");
  const report = createCourseAuditSample(JSON.parse(await readFile(input, "utf8")), Number(size));
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(`Requirements: ${report.counts.requirements}; mandatory: ${report.counts.mandatory}; population: ${report.counts.population}; sampled: ${report.counts.sampled}; output: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCourseAuditSample(process.argv.slice(2)).catch(() => {
    console.error("Course audit sampling failed: check local input, versions, sample size and new output path; use --help.");
    process.exitCode = 1;
  });
}
