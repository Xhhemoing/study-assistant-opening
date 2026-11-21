import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from checks import allowed_doc, check_gate, git_environment

SCRIPT = Path(__file__).with_name("checks.py").resolve()
REPO = SCRIPT.parents[2]


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        home = self.root / '.private-home'
        for directory in (home, home / 'xdg', home / 'templates', home / 'hooks'):
            directory.mkdir(exist_ok=True)
        self.env = {**git_environment(), 'HOME': str(home), 'XDG_CONFIG_HOME': str(home / 'xdg'),
                    'GIT_DIR': str(self.root / '.git'), 'GIT_WORK_TREE': str(self.root),
                    'GIT_INDEX_FILE': str(self.root / '.git/index'), 'GIT_TEMPLATE_DIR': str(home / 'templates'),
                    'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.hooksPath',
                    'GIT_CONFIG_VALUE_0': str(home / 'hooks')}
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.invalid")
        self.git("config", "user.name", "CI test")
        self.put("docs/a.md", "hello\n")
        self.put("src/code.py", "print('hello')\n")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, env=self.env, stderr=subprocess.PIPE).decode().strip()

    def put(self, path, text):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_check(self, mode, base=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), mode], cwd=self.root,
            env={**self.env, "DIFF_BASE": self.base if base is None else base,
                 "DIFF_HEAD": self.git("rev-parse", "HEAD"),
                 "GITHUB_OUTPUT": str(self.root / ".git/output")},
            text=True, capture_output=True,
        )

    def assert_classification(self, expected):
        result = self.run_check("classify")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), f"docs_only={str(expected).lower()}")

    def test_docs_with_spaces_and_newline_and_actual_light_check(self):
        # A Git tree can hold this name even when the checkout filesystem cannot.
        blob = self.git("rev-parse", "HEAD:docs/a.md")
        self.git("-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo",
                 "100644", blob, "docs/a space\nand newline.md")
        self.git("commit", "-qm", "add unusual documentation path")
        self.assert_classification(True)
        self.assertEqual(self.run_check("docs").returncode, 0)

    def copy_repo_file(self, path):
        self.put(path, (REPO / path).read_text(encoding="utf-8"))

    def assert_full_and_light_rejected(self):
        self.assert_classification(False)
        self.assertNotEqual(self.run_check("docs").returncode, 0)

    def test_plan_baseline_todo_is_full(self):
        path = "docs/superpowers/plans/opening-release/00-baseline.md"
        self.copy_repo_file(path)
        self.base = self.commit()
        original = (self.root / path).read_text(encoding="utf-8")
        self.put(path, original + "\nTODO\n")
        self.commit()
        self.assert_full_and_light_rejected()

    def test_ci_guide_required_keyword_deletion_is_full(self):
        path = "docs/operations/ci.md"
        self.copy_repo_file(path)
        self.base = self.commit()
        original = (self.root / path).read_text(encoding="utf-8")
        self.assertIn("exact commit SHA", original)
        self.put(path, original.replace("exact commit SHA", "commit"))
        self.commit()
        self.assert_full_and_light_rejected()

    def test_task_referenced_evidence_deletion_is_full(self):
        manifest = "docs/superpowers/plans/opening-release/tasks.json"
        self.copy_repo_file(manifest)
        tasks = json.loads((self.root / manifest).read_text(encoding="utf-8"))["tasks"]
        reference = next(e for t in tasks for e in t.get("evidence", []) if e.endswith(".md"))
        evidence = (REPO / manifest).parent.joinpath(reference).resolve().relative_to(REPO)
        self.copy_repo_file(evidence)
        self.base = self.commit()
        self.git("rm", str(evidence))
        self.commit()
        self.assert_full_and_light_rejected()

    def test_quality_and_deployment_docs_are_full(self):
        for path in ("docs/quality/checks.md", "docs/quality/result.txt",
                     "docs/operations/cloud-deployment.md"):
            with self.subTest(path=path):
                self.put(path, "checked documentation\n")
                self.base = self.commit()
                self.put(path, "changed checked documentation\n")
                self.commit()
                self.assert_full_and_light_rejected()

    def test_protected_doc_renamed_to_ordinary_doc_is_full(self):
        path = "docs/superpowers/evidence/checked.md"
        self.put(path, "checked evidence\n")
        self.base = self.commit()
        self.git("mv", path, "docs/ordinary.md")
        self.commit()
        self.assert_full_and_light_rejected()

    def test_readme_and_ordinary_prose_remain_light(self):
        self.put("README.md", "ordinary README update\n")
        self.put("docs/guide.txt", "ordinary guide\n")
        self.commit()
        self.assert_classification(True)
        self.assertEqual(self.run_check("docs").returncode, 0)

    def test_mixed_and_all_pr_commits_not_last_commit(self):
        self.put("src/code.py", "print('changed')\n")
        self.commit()
        self.put("docs/a.md", "documentation last commit\n")
        self.commit()
        self.assert_classification(False)
        self.assertNotEqual(self.run_check("docs").returncode, 0)

    def test_docs_rename_and_delete(self):
        self.git("mv", "docs/a.md", "docs/renamed.md")
        self.commit()
        self.assert_classification(True)
        self.base = self.git("rev-parse", "HEAD")
        self.git("rm", "docs/renamed.md")
        self.commit()
        self.assert_classification(True)

    def test_code_renamed_to_doc_is_full(self):
        self.git("mv", "src/code.py", "docs/code.md")
        self.commit()
        self.assert_classification(False)

    def test_code_delete_is_full(self):
        self.git("rm", "src/code.py")
        self.commit()
        self.assert_classification(False)

    def test_dependency_workflow_and_scripts_are_full(self):
        for path in ("package-lock.json", ".github/workflows/ci.yml", "scripts/ci/notes.md",
                     "docs/tasks.json", "docs/AGENTS.md", "docs/STATUS.md", "AGENTS.md"):
            with self.subTest(path=path):
                self.assertFalse(allowed_doc(path))

    def test_empty_diff_is_full(self):
        self.assert_classification(False)

    def test_type_change_is_full(self):
        (self.root / "docs/a.md").unlink()
        (self.root / "docs/a.md").symlink_to("../src/code.py")
        self.commit()
        self.assert_classification(False)

    def test_added_symlink_is_full(self):
        (self.root / "docs/link.md").symlink_to("../src/code.py")
        self.commit()
        self.assert_classification(False)

    def test_whitespace_failure_is_real_failure(self):
        self.put("docs/a.md", "trailing space  \n")
        self.commit()
        self.assert_classification(True)
        self.assertNotEqual(self.run_check("docs").returncode, 0)

    def test_manual_and_initial_push_are_full_invalid_sha_fails(self):
        for base in ("", "0" * 40):
            result = self.run_check("classify", base)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "docs_only=false")
        self.assertNotEqual(self.run_check("classify", "invalid-sha").returncode, 0)


QUALITY_WORKERS = ["static-unit", "integration-parser", "handler-browser-spikes", "build"]
WORKER_FLOW = ["opening-worker-flow"]


class WorkflowTests(unittest.TestCase):
    def test_draft_routing_and_required_gate_inputs(self):
        # Use the YAML parser already installed by npm ci, including its anchor resolution.
        script = """const fs = require('node:fs');
const workflow = require('js-yaml').load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
console.log(JSON.stringify(workflow));"""
        workflow = json.loads(subprocess.check_output(["node", "-e", script], cwd=REPO))
        self.assertIn("ready_for_review", workflow["on"]["pull_request"]["types"])
        jobs = workflow["jobs"]
        self.assertIn("fast-draft-check", jobs)
        for name, workers in (("quality", QUALITY_WORKERS), ("worker-gate", WORKER_FLOW)):
            with self.subTest(gate=name):
                gate = jobs[name]
                self.assertIn("fast-draft-check", gate["needs"])
                step = next(step for step in gate["steps"] if "checks.py gate" in step.get("run", ""))
                self.assertIn("CI_IS_DRAFT", step["env"])
                self.assertCountEqual(step["run"].split("checks.py gate ")[1].split(), workers)


class GateTests(unittest.TestCase):
    def fixture(self, docs=False):
        return {
            "changes": {"result": "success", "outputs": {"docs_only": str(docs).lower()}},
            "docs": {"result": "success" if docs else "skipped"},
            "static-unit": {"result": "skipped" if docs else "success"},
            "integration-parser": {"result": "skipped" if docs else "success"},
            "handler-browser-spikes": {"result": "skipped" if docs else "success"},
            "fast-draft-check": {"result": "skipped"},
            "build": {"result": "skipped" if docs else "success"},
            "opening-worker-flow": {"result": "skipped" if docs else "success"},
        }

    def test_both_required_gates_success_on_real_checks(self):
        for docs in (False, True):
            for workers in (QUALITY_WORKERS, WORKER_FLOW):
                check_gate(self.fixture(docs), workers)

    def test_every_required_failure_cancellation_skip_or_absence_fails(self):
        for docs in (False, True):
            jobs = ["changes", "docs"] if docs else ["changes", *QUALITY_WORKERS, *WORKER_FLOW]
            for name in jobs:
                for result in ("failure", "cancelled", "skipped", None):
                    needs = self.fixture(docs)
                    if result is None:
                        del needs[name]
                    else:
                        needs[name]["result"] = result
                    with self.subTest(docs=docs, name=name, result=result):
                        with self.assertRaises(ValueError):
                            check_gate(needs, QUALITY_WORKERS + WORKER_FLOW)

    def test_invalid_or_missing_classifier_output_fails(self):
        for output in ({}, {"docs_only": ""}, {"docs_only": "TRUE"}):
            needs = self.fixture()
            needs["changes"]["outputs"] = copy.deepcopy(output)
            with self.assertRaises(ValueError):
                check_gate(needs, ["build"])

    def run_gate(self, needs, workers, draft):
        env = {**os.environ, "CI_NEEDS": json.dumps(needs)}
        if draft is None:
            env.pop("CI_IS_DRAFT", None)
        else:
            env["CI_IS_DRAFT"] = draft
        return subprocess.run([sys.executable, str(SCRIPT), "gate", *workers],
                              env=env, text=True, capture_output=True)

    def test_draft_code_rejects_both_gates_even_after_fast_success(self):
        for workers in (QUALITY_WORKERS, WORKER_FLOW):
            for status in ("success", "failure", "cancelled", "skipped", None):
                with self.subTest(workers=workers, status=status):
                    needs = self.fixture()
                    if status is None:
                        del needs["fast-draft-check"]
                    else:
                        needs["fast-draft-check"]["result"] = status
                    for worker in workers:
                        needs[worker]["result"] = "skipped"
                    result = self.run_gate(needs, workers, "true")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Ready for Review" if status == "success" else
                                  "fast-draft-check did not succeed", result.stderr)

    def test_draft_fast_success_never_authorizes_merge(self):
        needs = self.fixture()
        needs["fast-draft-check"]["result"] = "success"
        for workers in (QUALITY_WORKERS, WORKER_FLOW):
            with self.assertRaisesRegex(ValueError, "Ready for Review"):
                check_gate(needs, workers, is_draft=True)

    def test_docs_only_draft_uses_documentation_check(self):
        for workers in (QUALITY_WORKERS, WORKER_FLOW):
            needs = self.fixture(docs=True)
            check_gate(needs, workers, is_draft=True)
            needs["docs"]["result"] = "skipped"
            with self.assertRaisesRegex(ValueError, "docs did not succeed"):
                check_gate(needs, workers, is_draft=True)

    def test_invalid_or_missing_draft_flag_cannot_pass_full_gate(self):
        for flag in ("TRUE", "unknown", "", None):
            with self.subTest(flag=flag):
                result = self.run_gate(self.fixture(), QUALITY_WORKERS, flag)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("CI_IS_DRAFT", result.stderr)

    def test_cli_exit_code_does_not_swallow_failure(self):
        for status, expected in (("success", 0), ("failure", 1), ("cancelled", 1), ("skipped", 1)):
            needs = self.fixture()
            needs["build"]["result"] = status
            result = self.run_gate(needs, ["build"], "false")
            self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
