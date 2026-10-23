# Offline grading evaluation

Run from the repository root (no provider, network or database call):

```bash
node --import tsx scripts/study-grading-eval.ts \
  --dataset tests/fixtures/opening/grading/objective-arithmetic.json \
  --results tests/fixtures/opening/grading/objective-synthetic-run.json
```

`objective-arithmetic.json` contains eight development examples with explicit correct/incorrect labels for rational arithmetic. Labels are `program_verified` using `exact-arithmetic-v1`; evaluation recomputes each label with BigInt rational arithmetic and rejects unsupported or conflicting labels. This is not human review. The parser covers unit-free decimal/fraction arithmetic, parentheses and equality chains. It does not establish completion of a proof, word problem, units, approximate answers or a general mathematical derivation.

`objective-synthetic-run.json` contains synthetic outputs, including one deliberate false correct and one deliberate false incorrect. It demonstrates that the raw model error remains visible when the accepted policy abstains. Its `test_fixture` provenance must remain intact; its scores are not model performance. It also exercises the same arithmetic checker used by the acceptance policy, so this is a development regression dataset, not an independent semantic benchmark.

`review-candidates.json` contains twelve pending assistant-authored candidates across six error groups. Pending labels never count as scoring truth. A human review must identify the reviewer, time, outcome and rationale before changing a case to `human_reviewed`; do not promote a candidate because a model agrees with it. Photo cases additionally need an immutable image evidence reference and an actual matching result. The scorer compares captured image references but does not inspect image files or certify that a provider received them.

For a real run, capture each case's exact input, case version and raw grading JSON in the `gradingEvaluationRunSchema` format, with an explicit model label, completion time and `real_provider` provenance. Never relabel the synthetic file as a provider run. Versions and inputs must match the dataset; missing, malformed or mismatched results remain in the coverage denominator. Results preserve raw outcomes and accepted outcomes separately, show false correct/incorrect and unsafe binary judgments on unjudgeable cases, and separate human-reviewed from program-verified metrics. Confidence is an uncalibrated model self-report and is never treated as accuracy.

Reports retain the existing `coverage`, `acceptedAccuracy` and error counts. `acceptedAccuracy` describes only accepted binary decisions; it can be perfect when almost every answer is left ungraded. Read it together with the new `expectedCounts` and `decisionRates`, available in the summary, error-group and review-source breakdowns. Each rate includes its `numerator`, `denominator` and `rate`; zero-denominator rates are `null`, not zero.

| `decisionRates` field | Numerator | Denominator |
| --- | --- | --- |
| `falseCorrectOnIncorrect` | Incorrect student answers judged correct | All reviewed incorrect answers |
| `falseIncorrectOnCorrect` | Correct student answers judged incorrect | All reviewed correct answers |
| `binaryCoverageOnGradeable` | Correct/incorrect decisions on gradeable answers | All reviewed correct or incorrect answers |
| `abstentionOnGradeable` | Explicit `unverified` decisions on gradeable answers | All reviewed correct or incorrect answers |
| `missingOrInvalidOnGradeable` | Missing, malformed or mismatched results on gradeable answers | All reviewed correct or incorrect answers |
| `correctAbstentionOnUnverifiable` | Explicit `unverified` decisions where no reliable judgment is possible | All reviewed answers labelled `unverified` |
| `unsafeBinaryOnUnverifiable` | Correct/incorrect decisions where no reliable judgment is possible | All reviewed answers labelled `unverified` |
| `missingOrInvalidOnUnverifiable` | Missing, malformed or mismatched results where no reliable judgment is possible | All reviewed answers labelled `unverified` |

The corresponding `rawModel.decisionRates` uses the same class denominators before the acceptance policy and arithmetic corroboration. Pending candidates never enter these denominators. Missing/invalid results are a separate category, not abstentions or successful handling. Consequently, the binary coverage, abstention and missing/invalid rates partition gradeable cases; the correct abstention, unsafe binary and missing/invalid rates partition unverifiable cases. Error incidence rates include missing results in their class denominators and must be interpreted alongside these coverage and failure rates, not as evidence that an unprocessed answer was correctly graded.

Use `--output NEW_FILE` to create a private report; the script refuses to overwrite an existing file. No reports or scores are imported into learning history. Human semantic labels, real provider runs, photo verification and delayed learning outcomes remain to be collected.
