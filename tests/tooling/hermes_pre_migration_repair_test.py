"""Synthetic incident/manager facts, real descriptor-based read-only state reads.
No production state, PostgreSQL, systemd mutations or role grants.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'infra/deploy'
spec = importlib.util.spec_from_file_location('bootstrap', ROOT / 'hermes-trusted-loader.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
bootstrap.TRUSTED_UID = os.geteuid()
state = bootstrap.SourceLoader(ROOT).load('hermes-writer-state.py')
state.TRUSTED_UID = os.geteuid()


class Repair(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='repair-incident-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.incident = self.state / 'releases' / state.REPAIR_INCIDENT
        self.incident.mkdir(parents=True, mode=0o700)
        self.old = self.root / 'old'
        self.old.mkdir()
        self.write(self.old / '.release-sha', '1e511' + 'a' * 35 + '\n')
        self.current = self.root / 'current'
        self.current.symlink_to(self.old)
        (self.state / 'last-transition').symlink_to(self.state / 'releases' / '20261108T160832-39068')
        self.write(self.state / 'migration-forward-only', json.dumps({
            'transition': str(self.incident), 'reason': 'owner exited without durable success', 'ownerPid': 679352}))
        self.write(self.state / 'writers-fenced', 'fenced\n')
        self.write(self.state / 'activation-incomplete', str(self.incident) + '\n')
        self.write(self.incident / 'from-target', str(self.old) + '\n')
        backup = self.root / (state.REPAIR_BASELINE + '-original.dump')
        self.write(backup, 'full original backup fixture')
        self.write(self.incident / 'database-backup', str(backup) + '\n')
        self.write(self.incident / 'forward-armed', 'generic crash reason is not a migration boundary')
        self.systemd = self.root / 'systemd'
        self.systemd.mkdir()
        for unit in ('aistudy-web.service', state.WORKER):
            directory = self.systemd / (unit + '.d')
            directory.mkdir()
            self.write(directory / '95-aistudy-migration-fence.conf',
                       '[Unit]\nConditionPathExists=!' + str(self.state / 'writers-fenced') + '\n')
        self.manager_extra = ''
        self.owner_alive = False
        original = state.present
        def present(path):
            if str(path) == '/proc/679352':
                return self.owner_alive
            if str(path) == '/run/aistudy-writer-broker':
                return False
            if str(path) == '/sys/fs/cgroup/cgroup.controllers':
                return True
            return original(path)
        self.addCleanup(patch.stopall)
        patch.object(state, 'present', present).start()
        def manager(command, **options):
            unit = command[-1]
            fence = self.systemd / (unit + '.d') / '95-aistudy-migration-fence.conf'
            return subprocess.CompletedProcess(command, 0,
                'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\n'
                'ControlGroup=\nNeedDaemonReload=no\nDropInPaths=' + str(fence) + '\n' + self.manager_extra, '')
        patch.object(state.subprocess, 'run', manager).start()

    def write(self, path, contents):
        path.write_text(contents)
        path.chmod(0o600)

    def snapshot(self):
        return {str(path): (path.lstat().st_mode, path.lstat().st_mtime_ns,
                           path.lstat().st_ctime_ns, os.readlink(path) if path.is_symlink()
                           else path.read_bytes() if path.is_file() else None)
                for path in self.root.rglob('*')}

    def check(self):
        before = self.snapshot()
        try:
            return state.repair_check(str(self.state), str(self.current), str(self.systemd))
        finally:
            self.assertEqual(before, self.snapshot(), 'check wrote persistent state')

    def test_exact_incident_is_read_only_and_does_not_claim_database_eligibility(self):
        result = self.check()
        self.assertTrue(result['eligible'])
        self.assertEqual(result['scope'], 'pre-migration-filesystem-manager-only')
        self.assertFalse(result['automaticRetry'])

    def test_owner_alive_refuses_without_signal_or_rewrite(self):
        self.owner_alive = True
        with self.assertRaisesRegex(ValueError, 'death'):
            self.check()

    def test_migration_boundary_and_adoption_are_never_retryable(self):
        for path in (self.incident / 'migration-armed', self.incident / 'migration-plan.json',
                     self.incident / 'migration-succeeded', self.state / 'repair-adopted',
                     self.state / 'protocol2-transition.json', self.state / 'writer-controls'):
            with self.subTest(path=path.name):
                self.write(path, 'durable boundary')
                with self.assertRaises(ValueError):
                    self.check()
                path.unlink()

    def test_manager_reload_or_pid_or_duplicate_fields_refuse(self):
        for extra in ('NeedDaemonReload=yes\n', 'MainPID=123\n', 'Job=1\n'):
            self.manager_extra = extra
            with self.assertRaises(ValueError):
                self.check()

    def test_wrong_guard_or_target_or_new_wrapper_refuse(self):
        self.write(self.state / 'migration-forward-only', '{}')
        with self.assertRaises(ValueError):
            self.check()


if __name__ == '__main__':
    unittest.main()
