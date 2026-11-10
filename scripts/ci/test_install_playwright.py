"""Synthetic processes only: no sudo privileges, APT changes, downloads or browser."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("install-playwright.sh").resolve()
ROOT = SCRIPT.parents[2]
PLAYWRIGHT_CLI = ROOT / "node_modules/playwright/cli.js"
NODE = shutil.which("node")


class PlaywrightInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE or not PLAYWRIGHT_CLI.exists():
            raise RuntimeError("Node and npm ci required: fixtures must not silently skip")

    def run_installer(self, failure="", cache_hit="true", ci="true"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            scripts = {
                # Model sudo's secure_path; only explicit env arguments survive it.
                "sudo": '''#!/bin/bash
set -eu
[[ "$1" == -- ]]; shift
exec env PATH=/usr/bin:/bin "$@"
''',
                "apt-get": '''#!/bin/bash
set -eu
options=()
while [[ "$1" == -o ]]; do options+=("$1" "$2"); shift 2; done
printf 'apt:%s\\n' "$*" >> "$CALLS"
printf '%s' "${PATH%%:*}" > "$WRAPPER_PATH"
apt-config "${options[@]}" dump >> "$CONFIG_DUMP"
if [[ "$FAIL_ON" == "apt-$1" ]]; then exit 23; fi
''',
                "ldd": '''#!/bin/bash
set -eu
printf 'ldd:%s\\n' "$*" >> "$CALLS"
if [[ "$FAIL_ON" == ldd-exit ]]; then exit 24; fi
if [[ "$FAIL_ON" == ldd-missing ]]; then echo 'libfixture.so => not found'; fi
''',
            }
            for name, text in scripts.items():
                target = bin_dir / name
                target.write_text(text)
                target.chmod(0o755)
            cli = root / "node_modules/playwright/cli.js"
            cli.parent.mkdir(parents=True)
            # Run pinned Playwright's real dependency installer against fake apt-get.
            # Emulate root only in this child (no OS privileges are changed).
            cli.write_text(f'''
const fs = require('node:fs');
if (process.argv[2] === 'install-deps') {{
  process.getuid = () => 0;
  require({json.dumps(str(PLAYWRIGHT_CLI))});
}} else {{
  fs.appendFileSync(process.env.CALLS, `browser:${{process.argv.slice(2).join(' ')}}\\n`);
  process.exit(process.env.FAIL_ON === 'browser' ? 25 : 0);
}}
''')
            registry = root / "node_modules/playwright-core/lib/server/registry/index.js"
            registry.parent.mkdir(parents=True)
            registry.write_text('''
exports.registry = {
  findExecutable: name => ({ executablePath: () => `/fixture/${name}` })
};
''')
            calls_file = root / "calls"
            wrapper_path_file = root / "wrapper-path"
            config_dump_file = root / "config-dump"
            result = subprocess.run(
                ["bash", str(SCRIPT)], cwd=root, capture_output=True, text=True,
                timeout=20,
                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                     "GITHUB_ACTIONS": ci, "FAIL_ON": failure,
                     "PLAYWRIGHT_CACHE_HIT": cache_hit,
                     "CALLS": str(calls_file), "WRAPPER_PATH": str(wrapper_path_file),
                     "CONFIG_DUMP": str(config_dump_file)},
            )
            calls = calls_file.read_text().splitlines() if calls_file.exists() else []
            config = config_dump_file.read_text() if config_dump_file.exists() else ""
            if wrapper_path_file.exists():
                self.assertFalse(Path(wrapper_path_file.read_text()).exists(),
                                 "Temporary APT wrapper must be cleaned on success and failure")
            return result, calls, config

    def test_cache_hit_and_miss_install_deps_and_browser_then_check_all_libraries(self):
        for cache_hit in ("true", "false"):
            with self.subTest(cache_hit=cache_hit):
                result, calls, config = self.run_installer(cache_hit=cache_hit)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls[0], "apt:update")
                self.assertTrue(calls[1].startswith("apt:install -y --no-install-recommends "))
                self.assertEqual(calls[2:], ["browser:install chromium", "ldd:/fixture/chromium",
                                           "ldd:/fixture/chromium-headless-shell", "ldd:/fixture/ffmpeg"])
                for setting in ('Acquire::Retries "2";', 'Acquire::http::Timeout "15";',
                                'Acquire::https::Timeout "15";', 'APT::Update::Error-Mode "any";'):
                    self.assertEqual(config.count(setting), 2,
                                     "Both APT calls must parse CLI options after explicit sudo env PATH")
                self.assertEqual(result.stdout.count("Linked libraries OK:"), 3)

    def test_failures_never_become_success_or_continue_installation(self):
        for failure, count in (("apt-update", 1), ("apt-install", 2), ("browser", 3),
                               ("ldd-exit", 4), ("ldd-missing", 4)):
            with self.subTest(failure=failure):
                result, calls, _ = self.run_installer(failure=failure)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(len(calls), count, result.stderr)
                self.assertNotIn("Linked libraries OK:", result.stdout)

    def test_refuses_non_ci_invocation_before_sudo(self):
        result, calls, _ = self.run_installer(ci="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
