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
if [[ "$FAIL_ON" == static-* && "$1" == */ffmpeg ]]; then echo 'not a dynamic executable' >&2; exit 1; fi
''',
                "readelf": '''#!/bin/bash
set -eu
printf 'readelf:%s\\n' "$1" >> "$CALLS"
if [[ "$FAIL_ON" == static-inspect-failure ]]; then exit 1; fi
if [[ "$FAIL_ON" == static-empty-program && "$1" == -l ]]; then exit 0; fi
if [[ "$FAIL_ON" == static-empty-dynamic && "$1" == -d ]]; then exit 0; fi
if [[ "$FAIL_ON" == static-incomplete-program && "$1" == -l ]]; then echo 'Program Headers:'; exit 0; fi
if [[ "$FAIL_ON" == static-incomplete-dynamic && "$1" == -d ]]; then echo 'Dynamic section at offset 0x10 contains 1 entries:'; exit 0; fi
if [[ "$FAIL_ON" == static-warning && "$1" == -l ]]; then echo 'readelf: Warning: incomplete data' >&2; fi
case "$1" in
 -h) if [[ "$FAIL_ON" == static-invalid-header ]]; then echo 'not ELF'; else printf 'ELF Header:\\n  Type: EXEC (Executable file)\\n'; fi ;;
 -l) printf 'Elf file type is EXEC (Executable file)\\nEntry point 0x1000\\nThere are 2 program headers, starting at offset 64\\n\\nProgram Headers:\\n  Type           Offset             VirtAddr           PhysAddr\\n  LOAD           0x0000000000000000 0x0000000000000000 0x0000000000000000\\n'; if [[ "$FAIL_ON" == static-interpreter ]]; then echo ' INTERP '; fi ;;
 -d) if [[ "$FAIL_ON" == static-needed ]]; then printf 'Dynamic section at offset 0x10 contains 2 entries:\\n  Tag        Type                         Name/Value\\n 0x0000000000000001 (NEEDED) Shared library\\n 0x0000000000000000 (NULL) 0x0\\n'; elif [[ "$FAIL_ON" == static-valid-dynamic ]]; then printf 'Dynamic section at offset 0x10 contains 1 entries:\\n  Tag        Type                         Name/Value\\n 0x0000000000000000 (NULL) 0x0\\n'; else echo 'There is no dynamic section in this file.'; fi ;;
esac
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
  findExecutable: name => ({ executablePath: () => process.env.FIXTURE_BIN + '/' + name })
};
''')
            fixture_bin = root / 'executables'
            fixture_bin.mkdir()
            for name in ('chromium', 'chromium-headless-shell', 'ffmpeg'):
                executable = fixture_bin / name
                executable.write_text('synthetic executable')
                executable.chmod(0o700)
            calls_file = root / "calls"
            wrapper_path_file = root / "wrapper-path"
            config_dump_file = root / "config-dump"
            result = subprocess.run(
                ["bash", str(SCRIPT)], cwd=root, capture_output=True, text=True,
                timeout=20,
                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                     "GITHUB_ACTIONS": ci, "FAIL_ON": failure,
                     "FIXTURE_BIN": str(fixture_bin),
                     "PLAYWRIGHT_CACHE_HIT": cache_hit,
                     "CALLS": str(calls_file), "WRAPPER_PATH": str(wrapper_path_file),
                     "CONFIG_DUMP": str(config_dump_file)},
            )
            calls = calls_file.read_text().replace(str(fixture_bin), '/fixture').splitlines() if calls_file.exists() else []
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

    def test_static_ffmpeg_requires_positive_elf_evidence(self):
        result, calls, _ = self.run_installer(failure='static-valid')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Static ELF verified: ffmpeg', result.stdout)
        self.assertEqual(calls[-3:], ['readelf:-h', 'readelf:-l', 'readelf:-d'])
        dynamic_result, _, _ = self.run_installer(failure='static-valid-dynamic')
        self.assertEqual(dynamic_result.returncode, 0, dynamic_result.stderr)
        for failure in ('static-inspect-failure', 'static-invalid-header', 'static-interpreter', 'static-needed',
                        'static-empty-program', 'static-empty-dynamic', 'static-incomplete-program',
                        'static-incomplete-dynamic', 'static-warning'):
            with self.subTest(failure=failure):
                result, _, _ = self.run_installer(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Static ELF verified:', result.stdout)

    def test_refuses_non_ci_invocation_before_sudo(self):
        result, calls, _ = self.run_installer(ci="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
