"""Exercise cache hit/miss and failure propagation without installing packages."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("install-parser.sh").resolve()


class InstallerTests(unittest.TestCase):
    def run_installer(self, hit, fail="", parser_path=".local/docling-venv/bin/python"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            parser = root / parser_path
            parser.parent.mkdir(parents=True)
            stub = '''#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == "-" ]]; then cat > "$SMOKE"; fi
if [[ -n "$FAIL_ON" && "$*" == *"$FAIL_ON"* ]]; then exit 23; fi
'''
            for target in (bin_dir / "python", parser):
                target.write_text(stub)
                target.chmod(0o755)
            result = subprocess.run(
                ["bash", str(SCRIPT)], cwd=root, capture_output=True, text=True,
                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                     "PARSER_PYTHON": str(parser), "PARSER_CACHE_HIT": hit,
                     "CALLS": str(root / "calls"), "SMOKE": str(root / "smoke"),
                     "FAIL_ON": fail},
            )
            calls = (root / "calls").read_text().splitlines() if (root / "calls").exists() else []
            smoke = (root / "smoke").read_text() if (root / "smoke").exists() else ""
            return result, calls, smoke

    def test_miss_installs_hit_does_not_both_check_and_smoke(self):
        for hit in ("true", "false", ""):
            result, calls, smoke = self.run_installer(hit)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = ["-m pip check", "-"]
            if hit != "true":
                expected = ["-m venv --clear .local/docling-venv",
                            "-m pip install -r services/parser/requirements-lock.txt", *expected]
            self.assertEqual(calls, expected)
            self.assertIn("import docling", smoke)
            self.assertIn("import torch", smoke)
            self.assertIn("import torchvision", smoke)
            self.assertIn("torch.version.cuda is None", smoke)
            self.assertIn("assert nms(", smoke)

    def test_miss_rejects_unexpected_parser_path_before_clearing_venv(self):
        for parser_path in ("other-venv/bin/python", ".local/docling-venv/bin/other-python"):
            with self.subTest(parser_path=parser_path):
                result, calls, _ = self.run_installer("false", parser_path=parser_path)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("-m venv --clear .local/docling-venv", calls)
                self.assertEqual(calls, [], "Invalid paths must fail before any Python command")

    def test_install_check_and_smoke_failure_are_not_swallowed(self):
        for hit, fail in (("false", "pip install"), ("true", "pip check"),
                          ("false", "pip check"), ("true", "-"), ("false", "-")):
            with self.subTest(hit=hit, fail=fail):
                result, _, _ = self.run_installer(hit, fail)
                self.assertEqual(result.returncode, 23, result.stderr)


if __name__ == "__main__":
    unittest.main()
