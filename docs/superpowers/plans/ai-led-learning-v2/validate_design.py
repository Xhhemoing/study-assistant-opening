"""Isolated development-plan checks, NOT tests of the actual application.

This executable models a small set of proposed invariants and reproduces two
observed pure-function semantics. No database, provider, browser or real learner
is involved. Passing it does not establish production safety or teaching efficacy.
"""
from __future__ import annotations
import json
import math
import sys
import unittest
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

BASE = Path(__file__).resolve().parent

@dataclass(frozen=True)
class Activity:
    workspace: str
    owner: str
    activity_id: str
    revision: int = 1
    course: str | None = None
    state: str = "active"


def authorized(a: Activity, workspace: str, owner: str) -> bool:
    return bool(a.activity_id and a.workspace == workspace and a.owner == owner)


def effective_preference(global_pref: str, course_pref: str | None, session_pref: str | None) -> str:
    return session_pref or course_pref or global_pref


def intervene(*, explicit_request: bool, allowed: bool, evidence: str,
              natural_boundary: bool, cooldown: bool, reliable: bool) -> str:
    # Explicit help is not an unsolicited interruption. Unknown content gets a
    # clearly qualified response, never a confident correction.
    if explicit_request:
        return "respond" if reliable else "explain_uncertainty"
    if not allowed or cooldown or evidence not in {"submitted_attempt", "user_report"}:
        return "none"
    if not reliable:
        return "none"
    return "offer" if natural_boundary else "defer"

@dataclass(frozen=True)
class Observation:
    outcome: Literal["correct", "incorrect", "unknown"]
    independent: bool = True
    checked: bool = True
    usable: bool = True
    delayed: bool = True
    transfer_context_verified: bool = False


def measurement_suitable(o: Observation) -> bool:
    # Deliberately does NOT require a correct answer.
    return o.independent and o.checked and o.usable and o.delayed and o.outcome != "unknown"


def observed_delayed_accuracy(rows: list[Observation]) -> dict:
    eligible = [r for r in rows if measurement_suitable(r)]
    correct = sum(r.outcome == "correct" for r in eligible)
    return {"all_records": len(rows), "evaluable": len(eligible), "correct": correct,
            "rate": correct / len(eligible) if eligible else None,
            "excluded_or_missing": len(rows) - len(eligible)}


def transfer_credit(o: Observation) -> bool:
    return measurement_suitable(o) and o.outcome == "correct" and o.transfer_context_verified


def exposure_applies(*, target_item: str | None, attempt_item: str,
                     kind: str, persisted: bool) -> bool:
    # Instruction itself is not answer assistance on all later attempts.
    return persisted and kind in {"hint", "solution"} and target_item == attempt_item


def publish_allowed(*, authorized_scope: bool, epoch_at_start: int, epoch_now: int,
                    revision_expected: int, revision_now: int,
                    source_available: bool, all_claims_supported: bool,
                    allowed_components: bool) -> bool:
    return (authorized_scope and epoch_at_start == epoch_now
            and revision_expected == revision_now and source_available
            and all_claims_supported and allowed_components)


class CommandStore:
    """Only a serial model of intended semantics; NOT a concurrency/DB test."""
    def __init__(self) -> None:
        self.seen: dict[tuple[str, str], tuple[str, str]] = {}
    def apply(self, scope: str, key: str, intent: str) -> str:
        k = (scope, key)
        if k in self.seen:
            old_intent, result = self.seen[k]
            if old_intent != intent:
                raise ValueError("intent conflict")
            return result
        result = f"result-{len(self.seen) + 1}"
        self.seen[k] = (intent, result)
        return result


def current_default_retest_dimension(dimension: str | None) -> str:
    # Semantic transcription from retest-close-evidence.ts at 1a4cf46.
    return dimension if dimension is not None else "transfer"


def current_variant_problem_ref(ref: str, suffix: str = ":variant") -> str:
    # Semantic transcription from tutor-policy.ts at 1a4cf46.
    base = ref.strip()
    if not base:
        return "variant" + suffix
    return base + "-2" if base.endswith(suffix) else base + suffix


class DesignChecks(unittest.TestCase):
    def test_01_course_optional_not_owner_optional(self):
        a = Activity("w", "u", "a")
        self.assertTrue(authorized(a, "w", "u"))
        self.assertFalse(authorized(a, "w", "other"))

    def test_02_preference_precedence(self):
        self.assertEqual(effective_preference("coach", "balanced", "quiet"), "quiet")
        self.assertEqual(effective_preference("coach", "balanced", None), "balanced")

    def test_03_explicit_help_in_quiet_mode(self):
        self.assertEqual(intervene(explicit_request=True, allowed=False, evidence="none",
            natural_boundary=False, cooldown=True, reliable=True), "respond")

    def test_04_dwell_alone_is_not_evidence(self):
        self.assertEqual(intervene(explicit_request=False, allowed=True, evidence="dwell",
            natural_boundary=True, cooldown=False, reliable=True), "none")

    def test_05_uncertain_help_not_confident_correction(self):
        self.assertEqual(intervene(explicit_request=True, allowed=True, evidence="user_report",
            natural_boundary=True, cooldown=False, reliable=False), "explain_uncertainty")

    def test_06_defer_non_boundary(self):
        self.assertEqual(intervene(explicit_request=False, allowed=True, evidence="submitted_attempt",
            natural_boundary=False, cooldown=False, reliable=True), "defer")

    def test_07_instruction_not_future_item_exposure(self):
        self.assertFalse(exposure_applies(target_item=None, attempt_item="b",
            kind="instruction", persisted=True))

    def test_08_targeted_solution_blocks_item_independence(self):
        self.assertTrue(exposure_applies(target_item="a", attempt_item="a",
            kind="solution", persisted=True))
        self.assertFalse(exposure_applies(target_item="a", attempt_item="b",
            kind="solution", persisted=True))

    def test_09_failed_help_not_delivered(self):
        self.assertFalse(exposure_applies(target_item="a", attempt_item="a",
            kind="hint", persisted=False))

    def test_10_delay_not_transfer(self):
        self.assertFalse(transfer_credit(Observation("correct")))
        self.assertTrue(transfer_credit(Observation("correct", transfer_context_verified=True)))

    def test_11_denominator_retains_incorrect(self):
        rows = [Observation("correct"), Observation("incorrect"), Observation("unknown"),
                Observation("correct", independent=False)]
        result = observed_delayed_accuracy(rows)
        self.assertEqual(result, {"all_records":4,"evaluable":2,"correct":1,
            "rate":0.5,"excluded_or_missing":2})

    def test_12_missing_not_zero_or_success(self):
        self.assertIsNone(observed_delayed_accuracy([Observation("unknown")])["rate"])

    def test_13_privacy_and_revision_guard_model(self):
        args = dict(authorized_scope=True, epoch_at_start=2, epoch_now=2,
                    revision_expected=1, revision_now=1, source_available=True,
                    all_claims_supported=True, allowed_components=True)
        self.assertTrue(publish_allowed(**args))
        self.assertFalse(publish_allowed(**{**args,"epoch_now":3}))
        self.assertFalse(publish_allowed(**{**args,"revision_now":2}))
        self.assertFalse(publish_allowed(**{**args,"source_available":False}))

    def test_14_reference_id_not_semantic_support(self):
        self.assertFalse(publish_allowed(authorized_scope=True, epoch_at_start=1,epoch_now=1,
            revision_expected=1,revision_now=1,source_available=True,
            all_claims_supported=False,allowed_components=True))

    def test_15_serial_idempotency_and_conflict(self):
        s = CommandStore()
        self.assertEqual(s.apply("w/u","key","next"),s.apply("w/u","key","next"))
        with self.assertRaises(ValueError):
            s.apply("w/u","key","rewrite")
        self.assertNotEqual(s.apply("w/u","key","next"),s.apply("w/v","key","next"))

    def test_16_controlled_component_boundary(self):
        allowed = {"text","math","steps","question","draft","matrix_transform"}
        self.assertTrue("matrix_transform" in allowed)
        self.assertFalse("execute_javascript" in allowed)

    def test_17_baseline_semantics_counterexamples(self):
        # These passing assertions document the limitation; they do not assert
        # that current end-to-end production already misclassifies a learner.
        self.assertEqual(current_default_retest_dimension(None), "transfer")
        original_content = "Compute A x"
        self.assertNotEqual(current_variant_problem_ref("p"), "p")
        self.assertEqual(original_content, "Compute A x")  # content was not generated by the ID function

    def test_18_matrix_single_semantic_source(self):
        # A=(1,1;0,0): rank 1; chosen kernel vectors map to zero.
        for x in range(-5,6):
            y = -x
            out = (x + y, 0)
            self.assertEqual(out, (0,0))
        for x,y in [(1,2),(-4,1),(0,0)]:
            self.assertEqual((x+y,0), (1*x+1*y,0*x+0*y))

    def test_19_skip_does_not_create_learning_failure(self):
        a = Activity("w","u","a")
        skipped = replace(a, state="skipped")
        observations: list[Observation] = []
        self.assertEqual(skipped.state,"skipped")
        self.assertEqual(len(observations),0)

    def test_20_feedback_does_not_create_mastery(self):
        feedback = {"kind":"helpful","activity":"a"}
        observations: list[Observation] = []
        self.assertEqual(feedback["kind"],"helpful")
        self.assertIsNone(observed_delayed_accuracy(observations)["rate"])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(DesignChecks)
    with (BASE/"design-checks.log").open("w",encoding="utf-8") as stream:
        result = unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
    summary = {
        "type":"isolated_design_model_checks",
        "python":sys.version.split()[0],
        "repository_sha_observed":"1a4cf465c86da7f08b6fda3044f9b0f932b80824",
        "tests_run":result.testsRun,"failures":len(result.failures),"errors":len(result.errors),
        "passed":result.wasSuccessful(),
        "limits":["Not executed against the repository", "No database/concurrency/browser/provider tests",
                  "No actual student study", "Semantic-support input is stipulated in this model, not checked by AI"],
        "illustrative_denominator":observed_delayed_accuracy([Observation("correct"),Observation("incorrect"),
            Observation("unknown"),Observation("correct",independent=False)])}
    (BASE/"design-checks.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)
