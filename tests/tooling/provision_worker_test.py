import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("provision_worker", ROOT / "infra/deploy/provision-worker.py")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)
ensure_identity = worker.ensure_identity


class WorkerProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.legacy = self.base / "legacy"
        self.release = self.base / "releases/new"
        self.current = self.base / "current"
        self.config = self.base / "etc/aistudy"
        self.units = self.base / "etc/systemd/system"
        self.cache = self.base / "cache"
        self.state = self.base / "deployment/state"
        self.python = self.legacy / ".local/venv/bin/python"
        self.python.parent.mkdir(parents=True)
        self.python.symlink_to(sys.executable)
        (self.python.parent.parent / "pyvenv.cfg").write_text("home = /usr/bin\n")
        self.env = self.legacy / ".env.production"
        self.env.write_text(f'PARSER_PYTHON="{self.python}"\nDATABASE_URL=private-db\nUNUSED=$(touch {self.base / "injected"})\n')
        self.old_env = self.env.read_bytes()
        parser = self.release / "services/parser/opening_parser"
        parser.mkdir(parents=True)
        (parser / "__main__.py").write_text("pass\n")
        source = self.release / "apps/worker/src"
        source.mkdir(parents=True)
        (source / "index.ts").write_text("export {};\n")
        (self.release / "node_modules").mkdir(mode=0o700)
        (self.release / "node_modules/private-built.js").write_text("module.exports = {};\n")
        self.current.symlink_to(self.legacy, target_is_directory=True)
        self.units.mkdir(parents=True)
        self.config.mkdir(parents=True)
        self.unit = self.units / "aistudy-worker.service"
        self.runtime = self.config / "worker-runtime.env"
        self.unit.write_text("old worker unit\n")
        self.runtime.write_text("OLD_RUNTIME=1\n")
        self.calls = []
        self.fail_check = False
        self.fail_reload = False
        self.unsafe_effective_user = False
        self.stack = []
        for target, value in (("os.geteuid", lambda: 0), ("os.chown", lambda *args, **kwargs: None),
                              ("ensure_identity", lambda: (os.getuid(), os.getgid())),
                              ("run", self.record_run),
                              ("subprocess.run", lambda *args, **kwargs: SimpleNamespace(returncode=1))):
            mock = patch(f"{worker.__name__}.{target}", value) if worker.__name__ in sys.modules else None
            if mock is None:
                owner = worker
                pieces = target.split(".")
                for piece in pieces[:-1]:
                    owner = getattr(owner, piece)
                mock = patch.object(owner, pieces[-1], value)
            mock.start()
            self.addCleanup(mock.stop)

    def record_run(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if self.fail_check and argv[0] == "runuser":
            raise subprocess.CalledProcessError(1, argv)
        if self.fail_reload and argv == ["systemctl", "daemon-reload"]:
            self.fail_reload = False
            raise subprocess.CalledProcessError(1, argv)
        if argv[:2] == ["systemctl", "show"]:
            return SimpleNamespace(returncode=0, stdout="\n".join([
                "User=" + ("root" if self.unsafe_effective_user else "aistudy-worker"),
                "Group=aistudy-worker", "ProtectSystem=strict", "PrivateTmp=yes",
                f"WorkingDirectory={self.current}", f"ReadWritePaths={self.cache}",
                f"EnvironmentFiles={self.env} (ignore_errors=no) {self.runtime} (ignore_errors=no)",
            ]))
        return SimpleNamespace(returncode=0)

    def args(self, *extra):
        return ["--app-dir", str(self.current), "--release-dir", str(self.release),
                "--legacy-app-dir", str(self.legacy), "--config-file", str(self.env),
                "--state-dir", str(self.state), "--config-dir", str(self.config),
                "--systemd-dir", str(self.units), "--cache-dir", str(self.cache), *extra]

    def test_provisions_read_only_release_and_checks_real_service_identity_before_reload(self):
        worker.main(self.args())
        unit = self.unit.read_text()
        self.assertIn("User=aistudy-worker\n", unit)
        self.assertIn("ProtectSystem=strict\n", unit)
        self.assertIn(f'WorkingDirectory="{self.current}"', unit)
        self.assertLess(unit.index(str(self.env)), unit.index(str(self.runtime)))
        runtime = self.runtime.read_text()
        self.assertIn(f'PARSER_CWD="{self.current}/services/parser"', runtime)
        self.assertIn('PARSER_TEMP_DIR="/tmp/opening-parser"', runtime)
        self.assertNotIn("private-db", runtime)
        self.assertEqual(self.env.read_bytes(), self.old_env)
        self.assertFalse((self.base / "injected").exists())
        self.assertEqual(self.runtime.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.release / "node_modules").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.release / "node_modules/private-built.js").stat().st_mode & 0o022, 0)
        check = next((index, call) for index, call in enumerate(self.calls) if call[0][0] == "runuser")
        reload_index = next(index for index, call in enumerate(self.calls) if call[0] == ["systemctl", "daemon-reload"])
        self.assertLess(check[0], reload_index)
        self.assertEqual(check[1][1]["cwd"], self.release / "services/parser")
        self.assertIn("-i", check[1][0])
        self.assertFalse(any("DATABASE_URL" in argument for argument in check[1][0]))
        self.assertFalse(any(call[0][0] == "systemctl" and call[0][1] in ("start", "stop", "restart", "enable") for call in self.calls))

    def test_preserves_legacy_cache_and_internal_links_and_does_not_overwrite_on_rerun(self):
        old = self.legacy / ".local/hf-home"
        (old / "hub/blobs").mkdir(parents=True)
        (old / "hub/blobs/model").write_text("prepared offline model")
        (old / "token").write_text("private HF login token")
        (old / "stored_tokens").write_text("other private logins")
        snapshot = old / "hub/snapshots/version"
        snapshot.mkdir(parents=True)
        (snapshot / "model").symlink_to("../../blobs/model")
        worker.main(self.args())
        copied = self.cache / "hf-home/hub/snapshots/version/model"
        self.assertTrue(copied.is_symlink())
        self.assertEqual(copied.read_text(), "prepared offline model")
        self.assertFalse((self.cache / "hf-home/token").exists())
        self.assertFalse((self.cache / "hf-home/stored_tokens").exists())
        (self.cache / "hf-home/retained").write_text("new runtime data")
        worker.main(self.args())
        self.assertEqual((self.cache / "hf-home/retained").read_text(), "new runtime data")
        self.assertEqual((old / "hub/blobs/model").read_text(), "prepared offline model")
        self.assertEqual((self.state / "worker-before/aistudy-worker.service").read_text(), "old worker unit\n")

    def test_snapshot_and_restore_need_no_app_or_config_and_do_not_restart(self):
        paths = ["--state-dir", str(self.state), "--config-dir", str(self.config), "--systemd-dir", str(self.units)]
        worker.main(["--snapshot", *paths])
        self.unit.write_text("changed unit")
        self.runtime.write_text("CHANGED=1")
        worker.main(["--restore", *paths])
        self.assertEqual(self.unit.read_text(), "old worker unit\n")
        self.assertEqual(self.runtime.read_text(), "OLD_RUNTIME=1\n")
        self.assertEqual([call[0] for call in self.calls], [["systemctl", "daemon-reload"]])

    def test_failed_user_preflight_keeps_old_unit_and_runtime(self):
        self.fail_check = True
        with self.assertRaises(subprocess.CalledProcessError):
            worker.main(self.args())
        self.assertEqual(self.unit.read_text(), "old worker unit\n")
        self.assertEqual(self.runtime.read_text(), "OLD_RUNTIME=1\n")
        self.assertFalse(any(call[0] == ["systemctl", "daemon-reload"] for call in self.calls))

    def test_failed_daemon_reload_restores_both_files(self):
        self.fail_reload = True
        with self.assertRaises(subprocess.CalledProcessError):
            worker.main(self.args())
        self.assertEqual(self.unit.read_text(), "old worker unit\n")
        self.assertEqual(self.runtime.read_text(), "OLD_RUNTIME=1\n")

    def test_conflicting_effective_drop_in_restores_both_files(self):
        self.unsafe_effective_user = True
        with self.assertRaisesRegex(ValueError, "effective worker isolation"):
            worker.main(self.args())
        self.assertEqual(self.unit.read_text(), "old worker unit\n")
        self.assertEqual(self.runtime.read_text(), "OLD_RUNTIME=1\n")

    def test_rejects_symlink_cache_without_touching_target(self):
        outside = self.base / "outside"
        outside.mkdir()
        private = outside / "private"
        private.write_text("do not change")
        private.chmod(0o400)
        self.cache.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "real directory"):
            worker.main(self.args())
        self.assertEqual(private.stat().st_mode & 0o777, 0o400)
        self.assertEqual(self.unit.read_text(), "old worker unit\n")

    def test_read_only_artifact_rejects_mutable_external_symlinks_without_touching_target(self):
        external = self.base / "external"
        external.write_text("outside release")
        external.chmod(0o640)
        (self.release / "linked-secret").symlink_to(external)
        with self.assertRaisesRegex(ValueError, "writable cache or temporary"):
            worker.main(self.args())
        self.assertEqual(external.stat().st_mode & 0o777, 0o640)

    def test_rejects_model_cache_links_outside_copied_home(self):
        old = self.legacy / ".local/hf-home"
        old.mkdir()
        outside = self.base / "outside-model"
        outside.write_text("outside the model cache")
        outside.chmod(0o400)
        (old / "escaped").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "outside the copied HF_HOME"):
            worker.main(self.args())
        self.assertEqual(outside.stat().st_mode & 0o777, 0o400)
        self.assertEqual(self.unit.read_text(), "old worker unit\n")

    def test_cache_staging_is_handed_over_only_after_all_recursive_operations(self):
        old = self.legacy / ".local/hf-home"
        (old / "hub").mkdir(parents=True)
        (old / "hub/model").write_text("offline model")
        events = []
        real_chmod = os.chmod
        real_rename = os.rename
        def chown(path, *args, **kwargs):
            events.append(("chown", Path(path)))
        def chmod(path, mode, **kwargs):
            events.append(("chmod", Path(path)))
            real_chmod(path, mode, **kwargs)
        def rename(source, target):
            events.append(("rename", Path(source)))
            real_rename(source, target)
        with patch.object(worker.os, "chown", chown), patch.object(worker.os, "chmod", chmod), \
                patch.object(worker.os, "rename", rename):
            worker.prepare_cache(self.cache, old, (1234, 1234))
        staging = events[-1][1]
        self.assertEqual(events[-2:], [("chown", staging), ("rename", staging)])
        self.assertEqual(sum(event == ("chown", staging) for event in events), 1)
        self.assertTrue(any(event[0] == "chmod" and event[1] != staging for event in events[:-2]))

    def test_restore_removes_managed_files_that_did_not_exist_before(self):
        self.unit.unlink()
        self.runtime.unlink()
        worker.main(self.args())
        self.assertTrue(self.unit.exists())
        worker.main(self.args("--restore"))
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.runtime.exists())

    def test_creates_dedicated_identity_and_rejects_a_root_alias(self):
        group = SimpleNamespace(gr_gid=123)
        account = SimpleNamespace(pw_uid=456, pw_gid=123, pw_shell="/usr/sbin/nologin")
        with patch.object(worker.grp, "getgrnam", side_effect=[KeyError(), group]), \
                patch.object(worker.pwd, "getpwnam", side_effect=[KeyError(), account]):
            self.assertEqual(ensure_identity(), (456, 123))
        self.assertTrue(any(call[0] == ["groupadd", "--system", "aistudy-worker"] for call in self.calls))
        self.assertTrue(any(call[0][0] == "useradd" and "/usr/sbin/nologin" in call[0] for call in self.calls))
        account.pw_uid = 0
        with patch.object(worker.grp, "getgrnam", return_value=group), \
                patch.object(worker.pwd, "getpwnam", return_value=account):
            with self.assertRaisesRegex(ValueError, "non-root"):
                ensure_identity()


if __name__ == "__main__":
    unittest.main()
