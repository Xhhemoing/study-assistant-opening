import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from checks import allowed_doc, check_gate

SCRIPT = Path(__file__).with_name("checks.py").resolve()


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.invalid")
        self.git("config", "user.name", "CI test")
        self.put("docs/a.md", "hello\n")
        self.put("src/code.py", "print('hello')\n")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def put(self, path, text):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_check(self, mode, base=None):
        return subprocess.run(
            ["python3", str(SCRIPT), mode], cwd=self.root,
            env={**os.environ, "DIFF_BASE": self.base if base is None else base,
                 "DIFF_HEAD": self.git("rev-parse", "HEAD"),
                 "GITHUB_OUTPUT": str(self.root / ".git/output")},
            text=True, capture_output=True,
        )

    def assert_classification(self, expected):
        result = self.run_check("classify")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), f"docs_only={str(expected).lower()}")

    def test_docs_with_spaces_and_newline_and_actual_light_check(self):
        self.put("docs/a space\nand newline.md", "valid\n")
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


class GateTests(unittest.TestCase):
    def fixture(self, docs=False):
        return {
            "changes": {"result": "success", "outputs": {"docs_only": str(docs).lower()}},
            "docs": {"result": "success" if docs else "skipped"},
            "static-unit": {"result": "skipped" if docs else "success"},
            "integration-browser": {"result": "skipped" if docs else "success"},
            "build": {"result": "skipped" if docs else "success"},
            "opening-worker-flow": {"result": "skipped" if docs else "success"},
        }

    def test_both_required_gates_success_on_real_checks(self):
        for docs in (False, True):
            for workers in (["static-unit", "integration-browser", "build"], ["opening-worker-flow"]):
                check_gate(self.fixture(docs), workers)

    def test_every_required_failure_cancellation_skip_or_absence_fails(self):
        for docs in (False, True):
            jobs = ["changes", "docs"] if docs else ["changes", "static-unit", "integration-browser", "build", "opening-worker-flow"]
            for name in jobs:
                for result in ("failure", "cancelled", "skipped", None):
                    needs = self.fixture(docs)
                    if result is None:
                        del needs[name]
                    else:
                        needs[name]["result"] = result
                    with self.subTest(docs=docs, name=name, result=result):
                        with self.assertRaises(ValueError):
                            check_gate(needs, ["static-unit", "integration-browser", "build", "opening-worker-flow"])

    def test_invalid_or_missing_classifier_output_fails(self):
        for output in ({}, {"docs_only": ""}, {"docs_only": "TRUE"}):
            needs = self.fixture()
            needs["changes"]["outputs"] = copy.deepcopy(output)
            with self.assertRaises(ValueError):
                check_gate(needs, ["build"])

    def test_cli_exit_code_does_not_swallow_failure(self):
        for status, expected in (("success", 0), ("failure", 1), ("cancelled", 1), ("skipped", 1)):
            needs = self.fixture()
            needs["build"]["result"] = status
            result = subprocess.run(
                ["python3", str(SCRIPT), "gate", "build"],
                env={**os.environ, "CI_NEEDS": json.dumps(needs)}, capture_output=True,
            )
            self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
