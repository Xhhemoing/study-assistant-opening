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
        self.values, self.stopped, self.conditions = {}, {}, {}
        for unit in ('aistudy-web.service', state.WORKER):
            directory = self.systemd / (unit + '.d')
            directory.mkdir()
            self.write(self.systemd / unit, '[Service]\nExecStart=/usr/bin/node server.js\n'
                       + ('MemoryMax=1024M\nMemoryHigh=896M\n' if unit == state.WORKER else ''))
            primary = directory / ('50-aistudy-release.conf' if unit != state.WORKER else '90-aistudy-protocol-guard.conf')
            self.write(primary, '[Service]\nWorkingDirectory=/opt/aistudy\n')
            fence = directory / '95-aistudy-migration-fence.conf'
            self.write(fence, '[Unit]\nConditionPathExists=!' + str(self.state / 'writers-fenced') + '\n')
            self.values[unit] = {
                'Id': unit, 'ControlGroup': '',
                'ExecStartEx': '{ path=/usr/bin/node ; argv[]=/usr/bin/node server.js ; flags= ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 ; }',
                'ExecStartPre': '', 'ExecStartPost': '', 'ExecCondition': '', 'ExecReload': '',
                'NeedDaemonReload': 'no', 'WorkingDirectory': '/opt/aistudy',
                'User': 'aistudy-worker' if unit == state.WORKER else '',
                'Group': 'aistudy-worker' if unit == state.WORKER else '',
                'FragmentPath': str(self.systemd / unit), 'DropInPaths': str(primary) + ' ' + str(fence),
                'EnvironmentFiles': '/opt/aistudy/.env.production (ignore_errors=no)',
                'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '', 'ProtectSystem': 'strict',
                'PrivateTmp': 'yes', 'ProtectHome': 'yes', 'ReadWritePaths': '/var/lib/aistudy',
                'Restart': 'on-failure', 'MemoryMax': '1073741824', 'MemoryHigh': '939524096'}
            self.stopped[unit] = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                'MainPID': '0', 'ControlPID': '0', 'Job': '', 'ControlGroup': '', 'NeedDaemonReload': 'no'}
            self.conditions[unit] = [['ConditionPathExists', False, True, str(self.state / 'writers-fenced'), 0]]
        self.manager_extra = ''
        self.configuration_extra = ''
        self.env_extra = {unit: ('/etc/aistudy/worker-runtime.env (ignore_errors=no)' if unit == state.WORKER
                               else '/opt/aistudy/.env.production (ignore_errors=no)') for unit in self.values}
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
        patch.dict(state.RESOURCE_ROOTS, {str(self.systemd): str(self.root / 'systemd.control')}).start()
        def manager(command, **options):
            if command[0] == '/usr/bin/busctl':
                unit = next(unit for unit in self.values if unit.replace('-', '_2d').replace('.', '_2e') in command[5])
                raw = json.dumps({'type': 'a(sbbsi)', 'data': self.conditions[unit]})
            elif '--all' in command:
                unit = command[-1]
                raw = ''.join(key + '=' + value + '\n' for key, value in self.stopped[unit].items())
                raw += 'DropInPaths=' + self.values[unit]['DropInPaths'] + '\n' + self.manager_extra
            else:
                unit = command[2]
                raw = ''.join(key + '=' + value + '\n' for key, value in self.values[unit].items())
                raw += 'EnvironmentFiles=' + self.env_extra[unit] + '\n' + self.configuration_extra
            return subprocess.CompletedProcess(command, 0, raw, '')
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
        for extra in ('NeedDaemonReload=yes\n', 'MainPID=123\n', 'Job=1\n', 'Unknown=\n'):
            self.manager_extra = extra
            with self.assertRaises(ValueError):
                self.check()

    def test_unknown_or_duplicate_dropins_refuse_before_eligibility(self):
        unit = state.WORKER
        original = self.values[unit]['DropInPaths']
        unknown = self.systemd / (unit + '.d') / '99-admin.conf'
        self.write(unknown, '[Unit]\nConditionPathExists=\n')
        for suffix in (' ' + str(unknown), ' ' + original.split()[-1]):
            with self.subTest(suffix=suffix):
                self.values[unit]['DropInPaths'] = original + suffix
                with self.assertRaisesRegex(ValueError, 'Unknown effective unit input'):
                    self.check()

    def test_effective_fence_missing_reset_positive_or_trigger_only_refuse(self):
        unit = state.WORKER
        for rows in ([], [['ConditionPathExists', False, False, str(self.state / 'writers-fenced'), 0]],
                     [['ConditionPathExists', True, True, str(self.state / 'writers-fenced'), 0]],
                     [['ConditionPathExists', False, True, '/different/fence', 0]]):
            with self.subTest(rows=rows):
                self.conditions[unit] = rows
                with self.assertRaisesRegex(ValueError, 'Effective negative fence'):
                    self.check()
        # Even a known late input cannot reset the effective conditions. This
        # models a manager after parsing the reset, while exact 95 stays intact.
        late = self.systemd / (unit + '.d') / 'memory.conf'
        self.write(late, '[Unit]\nConditionPathExists=\n[Service]\nMemoryMax=1G\n')
        self.values[unit]['DropInPaths'] += ' ' + str(late)
        self.conditions[unit] = []
        with self.assertRaisesRegex(ValueError, 'Effective negative fence'):
            self.check()

    def test_reviewed_resources_remain_bound_and_cannot_hide_condition_reset(self):
        unit = state.WORKER
        memory = self.systemd / (unit + '.d') / 'memory.conf'
        self.write(memory, '[Service]\nMemoryMax=1G\nMemoryHigh=896M\n')
        self.values[unit]['DropInPaths'] += ' ' + str(memory)
        self.assertTrue(self.check()['eligible'])
        for text in ('[Unit]\nConditionPathExists=\n[Service]\nMemoryMax=1G\n',
                     '[Service]\nMemoryHigh=2G\n'):
            self.write(memory, text)
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.check()

    def test_missing_stale_and_malformed_effective_conditions_refuse(self):
        unit = state.WORKER
        valid = self.conditions[unit][0]
        for rows in (None, [valid, valid], [['ConditionPathExists', 0, 1, valid[3], 0]],
                     [['ConditionPathExists', False, True, valid[3]]]):
            self.conditions[unit] = rows
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.check()
        self.conditions[unit] = [valid]
        fence = self.systemd / (unit + '.d') / '95-aistudy-migration-fence.conf'
        self.values[unit]['DropInPaths'] = self.values[unit]['DropInPaths'].replace(' ' + str(fence), '')
        with self.assertRaises(ValueError):
            self.check()

    def test_complete_manager_parser_and_ordered_environment_fail_closed(self):
        unit = state.WORKER
        for extra in ('NeedDaemonReload=no\n', 'Unknown=\n', 'ExecStartEx=\n', 'malformed\n'):
            self.configuration_extra = extra
            with self.subTest(extra=extra), self.assertRaises(PermissionError):
                self.check()
        self.configuration_extra = ''
        original = self.values[unit]['EnvironmentFiles']
        for value in ('', '/unknown/env (ignore_errors=no)', self.env_extra[unit]):
            self.values[unit]['EnvironmentFiles'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.check()
        self.values[unit]['EnvironmentFiles'] = original
        del self.values[unit]['ProtectSystem']
        with self.assertRaises(PermissionError):
            self.check()

    def test_reload_pid_and_job_values_refuse_without_duplicate_fields(self):
        for key, value in (('NeedDaemonReload', 'yes'), ('MainPID', '123'), ('ControlPID', '123'), ('Job', '1')):
            with self.subTest(key=key):
                original = self.stopped[state.WORKER][key]
                self.stopped[state.WORKER][key] = value
                with self.assertRaises(ValueError):
                    self.check()
                self.stopped[state.WORKER][key] = original

    def test_wrong_guard_or_target_or_new_wrapper_refuse(self):
        self.write(self.state / 'migration-forward-only', '{}')
        with self.assertRaises(ValueError):
            self.check()


if __name__ == '__main__':
    unittest.main()
