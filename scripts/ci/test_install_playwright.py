"""Synthetic processes only: no sudo privileges, APT changes, downloads or browser."""
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("install-playwright.sh").resolve()
ROOT = SCRIPT.parents[2]
PLAYWRIGHT_CLI = ROOT / "node_modules/playwright/cli.js"
NODE = shutil.which("node")
REAL_TIMEOUT = shutil.which("timeout")
FALLBACK_MIRROR = "https://playwright.download.prss.microsoft.com/dbazure/download/playwright"


def _kill_session(session_id: int) -> None:
    pgids = {session_id}
    pids = {session_id}
    proc_root = Path("/proc")
    if proc_root.is_dir():
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text()
                after_comm = stat[stat.rfind(")") + 2:].split()
                if int(after_comm[3]) == session_id:
                    pids.add(int(entry.name))
                    pgids.add(int(after_comm[2]))
            except (OSError, ValueError, IndexError):
                continue
    for pgid in pgids:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def _terminate_timed_out_proc(proc: subprocess.Popen) -> None:
    _kill_session(proc.pid)
    if proc.stdout:
        proc.stdout.close()
    if proc.stderr:
        proc.stderr.close()
    proc.wait(timeout=5)


class PlaywrightInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE or not REAL_TIMEOUT or not PLAYWRIGHT_CLI.exists():
            raise RuntimeError("Node, timeout and npm ci required: fixtures must not silently skip")

    def run_installer(self, failure="", cache_hit="true", ci="true", install_timeout=None):
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
                "timeout": f'''#!/bin/bash
set -eu
printf '%s %s\\n' "$1" "$2" >> "$TIMEOUT_CALLS"
exec {shlex.quote(REAL_TIMEOUT)} "$@"
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
  if (process.env.PLAYWRIGHT_DOWNLOAD_HOST || process.env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST) {{
    fs.appendFileSync(
      process.env.MIRROR_OVERRIDES,
      `${{process.env.PLAYWRIGHT_DOWNLOAD_HOST || ''}}|${{process.env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST || ''}}\\n`,
    );
  }}
  if (process.env.FAIL_ON === 'browser') {{
    process.exit(25);
  }} else if (process.env.FAIL_ON === 'browser-sigkill') {{
    process.kill(process.pid, 'SIGKILL');
  }} else if (process.env.FAIL_ON === 'browser-timeout-both') {{
    setTimeout(() => {{}}, 5000);
  }} else if (process.env.FAIL_ON === 'browser-timeout-once' || process.env.FAIL_ON === 'browser-timeout-then-fail') {{
    const attemptFile = process.env.BROWSER_ATTEMPT;
    if (!fs.existsSync(attemptFile)) {{
      fs.writeFileSync(attemptFile, '1');
      setTimeout(() => {{}}, 5000);
    }} else {{
      process.exit(process.env.FAIL_ON === 'browser-timeout-then-fail' ? 26 : 0);
    }}
  }} else {{
    process.exit(0);
  }}
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
            timeout_calls_file = root / "timeout-calls"
            wrapper_path_file = root / "wrapper-path"
            config_dump_file = root / "config-dump"
            mirror_overrides_file = root / "mirror-overrides"
            browser_attempt_file = root / "browser-attempt"
            env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                   "GITHUB_ACTIONS": ci, "FAIL_ON": failure,
                   "FIXTURE_BIN": str(fixture_bin),
                   "PLAYWRIGHT_CACHE_HIT": cache_hit,
                   "CALLS": str(calls_file),
                   "TIMEOUT_CALLS": str(timeout_calls_file),
                   "WRAPPER_PATH": str(wrapper_path_file),
                   "CONFIG_DUMP": str(config_dump_file),
                   "MIRROR_OVERRIDES": str(mirror_overrides_file),
                   "BROWSER_ATTEMPT": str(browser_attempt_file)}
            for var in ("PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS",
                        "PLAYWRIGHT_DOWNLOAD_HOST",
                        "PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST"):
                env.pop(var, None)
            if install_timeout is not None:
                env["PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS"] = str(install_timeout)
            proc = subprocess.Popen(
                ["bash", str(SCRIPT)], cwd=root, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, env=env, start_new_session=True,
            )
            try:
                stdout, stderr = proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                _terminate_timed_out_proc(proc)
                raise
            result = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
            calls = calls_file.read_text().replace(str(fixture_bin), '/fixture').splitlines() if calls_file.exists() else []
            timeout_calls = timeout_calls_file.read_text().splitlines() if timeout_calls_file.exists() else []
            config = config_dump_file.read_text() if config_dump_file.exists() else ""
            mirror_overrides = mirror_overrides_file.read_text() if mirror_overrides_file.exists() else ""
            if wrapper_path_file.exists():
                self.assertFalse(Path(wrapper_path_file.read_text()).exists(),
                                 "Temporary APT wrapper must be cleaned on success and failure")
            return result, calls, config, mirror_overrides, timeout_calls

    def test_cache_hit_and_miss_install_deps_and_browser_then_check_all_libraries(self):
        for cache_hit in ("true", "false"):
            with self.subTest(cache_hit=cache_hit):
                result, calls, config, mirror_overrides, timeout_calls = self.run_installer(cache_hit=cache_hit)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls[0], "apt:update")
                self.assertTrue(calls[1].startswith("apt:install -y --no-install-recommends "))
                self.assertEqual(calls[2:], ["browser:install chromium", "ldd:/fixture/chromium",
                                           "ldd:/fixture/chromium-headless-shell", "ldd:/fixture/ffmpeg"])
                self.assertEqual(timeout_calls, ["--kill-after=5s 120s"])
                for setting in ('Acquire::Retries "5";', 'Acquire::http::Timeout "15";',
                                'Acquire::https::Timeout "15";', 'APT::Update::Error-Mode "any";'):
                    self.assertEqual(config.count(setting), 2,
                                     "Both APT calls must parse CLI options after explicit sudo env PATH")
                self.assertEqual(mirror_overrides, "")
                self.assertEqual(result.stdout.count("Linked libraries OK:"), 3)

    def test_failures_never_become_success_or_continue_installation(self):
        for failure, count in (("apt-update", 1), ("apt-install", 2), ("browser", 3),
                               ("ldd-exit", 4), ("ldd-missing", 4)):
            with self.subTest(failure=failure):
                result, calls, _, _, _ = self.run_installer(failure=failure)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                if failure == "browser":
                    self.assertEqual(result.returncode, 25, result.stderr)
                self.assertEqual(len(calls), count, result.stderr)
                self.assertNotIn("Linked libraries OK:", result.stdout)

    def test_browser_timeout_retries_once_on_fallback_mirror_and_fails_closed(self):
        expected_override = f"{FALLBACK_MIRROR}|{FALLBACK_MIRROR}\n"

        result, calls, _, mirror_overrides, timeout_calls = self.run_installer(
            failure="browser-timeout-once", install_timeout="1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[2:], [
            "browser:install chromium",
            "browser:install chromium",
            "ldd:/fixture/chromium",
            "ldd:/fixture/chromium-headless-shell",
            "ldd:/fixture/ffmpeg",
        ])
        self.assertEqual(timeout_calls, ["--kill-after=5s 1s", "--kill-after=5s 1s"])
        self.assertEqual(mirror_overrides, expected_override)
        self.assertEqual(result.stdout.count("Linked libraries OK:"), 3)

        result, calls, _, mirror_overrides, timeout_calls = self.run_installer(
            failure="browser-timeout-then-fail", install_timeout="1",
        )
        self.assertEqual(result.returncode, 26, result.stderr)
        self.assertEqual(calls[2:], ["browser:install chromium", "browser:install chromium"])
        self.assertEqual(timeout_calls, ["--kill-after=5s 1s", "--kill-after=5s 1s"])
        self.assertFalse(any(call.startswith("ldd:") for call in calls), calls)
        self.assertEqual(mirror_overrides, expected_override)
        self.assertNotIn("Linked libraries OK:", result.stdout)

        result, calls, _, mirror_overrides, timeout_calls = self.run_installer(
            failure="browser-timeout-both", install_timeout="1",
        )
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertEqual(calls[2:], ["browser:install chromium", "browser:install chromium"])
        self.assertEqual(timeout_calls, ["--kill-after=5s 1s", "--kill-after=5s 1s"])
        self.assertFalse(any(call.startswith("ldd:") for call in calls), calls)
        self.assertEqual(mirror_overrides, expected_override)
        self.assertNotIn("Linked libraries OK:", result.stdout)

        result, calls, _, mirror_overrides, timeout_calls = self.run_installer(
            failure="browser-sigkill", install_timeout="1",
        )
        self.assertEqual(result.returncode, 137, result.stderr)
        self.assertEqual(calls[2:], ["browser:install chromium"])
        self.assertEqual(timeout_calls, ["--kill-after=5s 1s"])
        self.assertFalse(any(call.startswith("ldd:") for call in calls), calls)
        self.assertEqual(mirror_overrides, "")
        self.assertNotIn("Linked libraries OK:", result.stdout)

        for raw_valid, normalized in (("", "120s"), ("0060", "60s"), ("120", "120s")):
            with self.subTest(raw_valid=raw_valid):
                result, _, _, _, timeout_calls = self.run_installer(install_timeout=raw_valid)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(timeout_calls, [f"--kill-after=5s {normalized}"])

        for bad_timeout in ("0", "000", "-1", "00600", "121", "600", "18446744073709551617", "abc", "12s"):
            with self.subTest(bad_timeout=bad_timeout):
                result, calls, _, _, timeout_calls = self.run_installer(install_timeout=bad_timeout)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(calls, [])
                self.assertEqual(timeout_calls, [])
                self.assertNotIn("Linked libraries OK:", result.stdout)

    def test_watchdog_kills_detached_process_group_in_session(self):
        read_fd, write_fd = os.pipe()
        try:
            proc = subprocess.Popen(
                [
                    "bash", "-c", '"$@"; exit "$?"', "_",
                    REAL_TIMEOUT, "30s", sys.executable, "-c",
                    "import os, time; os.write(int(os.environ['READY_FD']), f'{os.getsid(0)}:{os.getpgrp()}\\n'.encode()); time.sleep(30)",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env={**os.environ, "READY_FD": str(write_fd)},
                pass_fds=(write_fd,),
                start_new_session=True,
            )
            os.close(write_fd)
            write_fd = -1
            ready, _, _ = select.select([read_fd], [], [], 5.0)
            self.assertTrue(ready, "Detached timeout child did not start")
            child_sid_str, child_pgid_str = os.read(read_fd, 64).decode().strip().split(":")
            self.assertEqual(int(child_sid_str), proc.pid)
            self.assertNotEqual(int(child_pgid_str), proc.pid)
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.communicate(timeout=0.1)
            _terminate_timed_out_proc(proc)
            eof_ready, _, _ = select.select([read_fd], [], [], 2.0)
            self.assertTrue(eof_ready, "Detached timeout process group still holds pipe open")
            self.assertEqual(os.read(read_fd, 1), b"")
        finally:
            if write_fd != -1:
                os.close(write_fd)
            os.close(read_fd)

    def test_static_ffmpeg_requires_positive_elf_evidence(self):
        result, calls, _, _, _ = self.run_installer(failure='static-valid')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Static ELF verified: ffmpeg', result.stdout)
        self.assertEqual(calls[-3:], ['readelf:-h', 'readelf:-l', 'readelf:-d'])
        dynamic_result, _, _, _, _ = self.run_installer(failure='static-valid-dynamic')
        self.assertEqual(dynamic_result.returncode, 0, dynamic_result.stderr)
        for failure in ('static-inspect-failure', 'static-invalid-header', 'static-interpreter', 'static-needed',
                        'static-empty-program', 'static-empty-dynamic', 'static-incomplete-program',
                        'static-incomplete-dynamic', 'static-warning'):
            with self.subTest(failure=failure):
                result, _, _, _, _ = self.run_installer(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Static ELF verified:', result.stdout)

    def test_refuses_non_ci_invocation_before_sudo(self):
        result, calls, _, _, timeout_calls = self.run_installer(ci="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])
        self.assertEqual(timeout_calls, [])


if __name__ == "__main__":
    unittest.main()
