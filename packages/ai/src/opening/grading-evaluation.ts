import { aiGradingProposalSchema, gradingEvaluationDatasetSchema, gradingEvaluationRunSchema } from "@aistudy/contracts";
import { acceptedAiGradingOutcome, checkArithmeticAnswer, corroborateArithmeticGrade } from "@aistudy/domain";
import { parseModelJson } from "./latex-json";

/** Solve P(Binomial(n, p) <= k) = 0.05 in log space (one-sided Clopper–Pearson). */
function upper95(k: number, n: number): number | null {
  if (!n) return null;
  if (k === n) return 1;
  if (!k) return -Math.expm1(Math.log(0.05) / n);
  let low = k / n, high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const p = (low + high) / 2;
    let logTerm = n * Math.log1p(-p), logSum = logTerm;
    for (let j = 1; j <= k; j += 1) {
      logTerm += Math.log(n - j + 1) - Math.log(j) + Math.log(p) - Math.log1p(-p);
      const maximum = Math.max(logSum, logTerm);
      logSum = maximum + Math.log(Math.exp(logSum - maximum) + Math.exp(logTerm - maximum));
    }
    if (logSum > Math.log(0.05)) low = p;
    else high = p;
  }
  return high;
}

function ratio(numerator: number, denominator: number) {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null, upper95: upper95(numerator, denominator) };
}

/** Offline evaluation only: never imports scores into a learner's history or treats AI labels as truth. */
export function evaluateGradingRun(rawDataset: unknown, rawRun: unknown) {
  const dataset = gradingEvaluationDatasetSchema.parse(rawDataset), run = gradingEvaluationRunSchema.parse(rawRun);
  if (run.datasetId !== dataset.datasetId || run.datasetVersion !== dataset.datasetVersion) throw new Error("Grading dataset version mismatch");
  if (run.protocolVersion !== dataset.protocolVersion) throw new Error("Grading protocol version mismatch");
  if (run.results.some(result => !dataset.cases.some(test => test.id === result.caseId))) throw new Error("Unknown grading case");
  const cases = dataset.cases.map(test => {
    const result = run.results.find(row => row.caseId === test.id);
    const reviewed = test.review.status !== "pending";
    if (test.review.status === "program_verified"
      && checkArithmeticAnswer(test.input.question, test.input.answer) !== test.review.outcome) {
      throw new Error(`Objective grading label could not be verified: ${test.id}`);
    }
    let reason: string | null = null;
    let modelOutcome: "correct" | "incorrect" | "unverified" | null = null;
    let acceptedOutcome: "correct" | "incorrect" | "unverified" | null = null;
    if (test.modality === "photo" && !test.input.imageEvidenceRef) reason = "photo_evidence_missing";
    else if (!result) reason = "model_result_missing";
    else if (result.caseVersion !== test.version || result.input.question !== test.input.question
      || result.input.answer !== test.input.answer || result.input.referenceText !== test.input.referenceText
      || result.input.imageEvidenceRef !== test.input.imageEvidenceRef) reason = "case_input_mismatch";
    else {
      let json: unknown;
      try { json = parseModelJson(result.rawOutput); } catch { reason = "invalid_model_output"; }
      const proposal = aiGradingProposalSchema.safeParse(json);
      if (!proposal.success) reason = "invalid_model_output";
      else {
        modelOutcome = proposal.data.outcome;
        const checked = test.modality === "text" ? corroborateArithmeticGrade(test.input.question, test.input.answer, proposal.data) : proposal.data;
        acceptedOutcome = acceptedAiGradingOutcome(checked);
      }
    }
    return { id: test.id, group: test.group, modality: test.modality, reviewed, reviewStatus: test.review.status,
      expected: test.review.status !== "pending" ? test.review.outcome : null,
      modelOutcome, acceptedOutcome, reason: reason ?? (reviewed ? null : "human_review_pending") };
  });
  function metrics(rows: typeof cases) {
    const reviewed = rows.filter(row => row.reviewed), judged = reviewed.filter(row => row.acceptedOutcome !== null);
    const accepted = judged.filter(row => row.acceptedOutcome !== "unverified");
    const correct = accepted.filter(row => row.acceptedOutcome === row.expected).length;
    const rawBinary = judged.filter(row => row.modelOutcome !== "unverified");
    const expectedCorrect = reviewed.filter(row => row.expected === "correct");
    const expectedIncorrect = reviewed.filter(row => row.expected === "incorrect");
    const unverifiable = reviewed.filter(row => row.expected === "unverified");
    const gradeable = [...expectedCorrect, ...expectedIncorrect];
    // Every reviewed case stays in its expected class, including missing/invalid results.
    const decisionRates = (field: "modelOutcome" | "acceptedOutcome") => ({
      falseCorrectOnIncorrect: ratio(expectedIncorrect.filter(row => row[field] === "correct").length, expectedIncorrect.length),
      falseIncorrectOnCorrect: ratio(expectedCorrect.filter(row => row[field] === "incorrect").length, expectedCorrect.length),
      binaryCoverageOnGradeable: ratio(gradeable.filter(row => row[field] === "correct" || row[field] === "incorrect").length, gradeable.length),
      abstentionOnGradeable: ratio(gradeable.filter(row => row[field] === "unverified").length, gradeable.length),
      missingOrInvalidOnGradeable: ratio(gradeable.filter(row => row[field] === null).length, gradeable.length),
      correctAbstentionOnUnverifiable: ratio(unverifiable.filter(row => row[field] === "unverified").length, unverifiable.length),
      unsafeBinaryOnUnverifiable: ratio(unverifiable.filter(row => row[field] === "correct" || row[field] === "incorrect").length, unverifiable.length),
      missingOrInvalidOnUnverifiable: ratio(unverifiable.filter(row => row[field] === null).length, unverifiable.length),
    });
    return { total: rows.length, verified: reviewed.length,
      humanReviewed: reviewed.filter(row => row.reviewStatus === "human_reviewed").length,
      programVerified: reviewed.filter(row => row.reviewStatus === "program_verified").length, validResults: judged.length,
      expectedCounts: { correct: expectedCorrect.length, incorrect: expectedIncorrect.length, unverified: unverifiable.length },
      decisionRates: decisionRates("acceptedOutcome"),
      missingOrInvalidResults: reviewed.length - judged.length, acceptedBinary: accepted.length,
      coverage: reviewed.length ? accepted.length / reviewed.length : null,
      acceptedAccuracy: accepted.length ? correct / accepted.length : null,
      falseCorrect: accepted.filter(row => row.expected === "incorrect" && row.acceptedOutcome === "correct").length,
      falseIncorrect: accepted.filter(row => row.expected === "correct" && row.acceptedOutcome === "incorrect").length,
      unsafeBinaryOnUnverifiable: accepted.filter(row => row.expected === "unverified").length,
      abstentions: judged.filter(row => row.acceptedOutcome === "unverified").length,
      justifiedAbstentions: judged.filter(row => row.acceptedOutcome === "unverified" && row.expected === "unverified").length,
      // Do not let a program-induced abstention conceal the model's original error.
      rawModel: {
        binary: rawBinary.length,
        accuracy: rawBinary.length ? rawBinary.filter(row => row.modelOutcome === row.expected).length / rawBinary.length : null,
        falseCorrect: rawBinary.filter(row => row.expected === "incorrect" && row.modelOutcome === "correct").length,
        falseIncorrect: rawBinary.filter(row => row.expected === "correct" && row.modelOutcome === "incorrect").length,
        unsafeBinaryOnUnverifiable: rawBinary.filter(row => row.expected === "unverified").length,
        decisionRates: decisionRates("modelOutcome"),
      } };
  }
  return { protocolVersion: dataset.protocolVersion, datasetId: dataset.datasetId, datasetVersion: dataset.datasetVersion,
    modelLabel: run.modelLabel, provenance: run.provenance, completedAt: run.completedAt,
    sourceCommit: run.sourceCommit, instructionVersion: run.instructionVersion, rubricVersion: run.rubricVersion, promptDigest: run.promptDigest,
    calibrated: false as const, learningEffectMeasured: false as const, summary: metrics(cases),
    groups: Object.fromEntries([...new Set(cases.map(row => row.group))].map(group => [group, metrics(cases.filter(row => row.group === group))])),
    byModality: Object.fromEntries([...new Set(cases.map(row => row.modality))].map(modality => [modality, metrics(cases.filter(row => row.modality === modality))])),
    byReviewSource: {
      humanReviewed: metrics(cases.filter(row => row.reviewStatus === "human_reviewed")),
      programVerified: metrics(cases.filter(row => row.reviewStatus === "program_verified")),
    },
    limitations: [
      "Pending candidate labels never enter accuracy or coverage denominators.",
      "Program-verified labels cover only the exact arithmetic language, not human review or general solution quality.",
      "Test-fixture outputs measure the evaluation harness, never a real provider's accuracy.",
      "Image references identify operator-supplied evidence; this offline scorer does not inspect images or certify their transmission.",
      "These descriptive grading metrics do not establish probability calibration or learning effects.",
    ], cases };
}
