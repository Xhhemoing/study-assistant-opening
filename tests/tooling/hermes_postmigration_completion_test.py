"""Synthetic incident, real readonly DAC/manager/payload comparison, no production."""
import contextlib
import fcntl
import functools
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_pre_migration_repair_test import Repair, state
GENERATED = sys.stdin.read() if '--generated-check' in sys.argv else None


class Completion(Repair):
    def setUp(self):
        super().setUp()
        self.new = self.state / 'releases' / state.COMPLETION_INCIDENT
        self.new.mkdir(mode=0o700)
        self.release = self.root / (state.COMPLETION_SHA + '-existing')
        self.release.mkdir()
        cache = self.root / 'worker-cache'
        cache.mkdir()
        patch.object(state, 'COMPLETION_CACHE', str(cache)).start()
        from types import SimpleNamespace
        patch.object(state.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.geteuid())).start()
        patch.object(state.os, 'statvfs', return_value=SimpleNamespace(f_bavail=8*1024**3, f_frsize=1)).start()
        self.config = self.root / 'config'
        self.write(self.config, 'synthetic config')
        self.write(self.release / 'payload', 'signed existing bytes')
        archive = self.root / 'retained.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(self.release / 'payload', arcname='payload')
        archive.chmod(0o600)
        self.archive = archive
        patch.object(state, 'COMPLETION_ARCHIVE_SHA', hashlib.sha256(archive.read_bytes()).hexdigest()).start()
        (self.release / '.env.production').symlink_to(self.config)
        scope = {'eligible': True, 'scope': 'pre-migration-filesystem-manager-only',
                 'baseline': state.REPAIR_BASELINE, 'incident': str(self.incident), 'automaticRetry': False}
        self.write(self.state / 'repair-adopted', json.dumps({**scope, 'transition': str(self.new),
                   'release': str(self.release), 'owner': state.COMPLETION_OWNER}))
        self.write(self.new / 'repair-adopted', json.dumps(scope))
        self.write(self.state / 'activation-incomplete', str(self.new) + '\n')
        self.write(self.new / 'from-target', str(self.old) + '\n')
        self.write(self.new / 'worker-required', '1\n')
        self.write(self.new / 'migration-armed', 'Migration execution authorized; outcome must be inspected.\n')
        self.write(self.new / 'forward-armed', 'Unknown/partial migration outcome requires forward repair.\n')
        backup = self.root / 'backup.dump'
        self.write(backup, 'synthetic complete backup')
        patch.object(state, 'COMPLETION_BACKUP_SIZE', backup.stat().st_size).start()
        patch.object(state, 'COMPLETION_BACKUP_SHA', hashlib.sha256(backup.read_bytes()).hexdigest()).start()
        self.write(self.new / 'database-backup', str(backup) + '\n')
        original = state.subprocess.run
        def commands(argv, **kwargs):
            restore = '/usr/lib/postgresql/16/bin/pg_restore'
            if argv == [restore, '--version']:
                import subprocess
                return subprocess.CompletedProcess(argv, 0, b'pg_restore (PostgreSQL) 16.11 (Ubuntu 16.11)\n', b'')
            if argv[:2] == [restore, '--list']:
                import subprocess
                return subprocess.CompletedProcess(argv, 0, b'TOC', b'')
            return original(argv, **kwargs)
        patch.object(state.subprocess, 'run', commands).start()

    def check(self):
        before = self.snapshot()
        try:
            if GENERATED is None:
                return state.completion_check(str(self.state), str(self.current), str(self.systemd),
                                              str(self.release), str(self.config), str(self.archive), str(self.root))
            namespace = {'__name__': 'completion_readonly_precheck'}
            previous = sys.gettrace()
            def trace(frame, event, arg):
                if frame.f_code.co_filename == '<completion-check>' and 'm' in namespace:
                    module = namespace['m']
                    module.TRUSTED_UID = os.geteuid()
                    module.present = state.present
                    module.RESOURCE_ROOTS = dict(state.RESOURCE_ROOTS)
                    module.COMPLETION_ARCHIVE_SHA = state.COMPLETION_ARCHIVE_SHA
                    module.COMPLETION_BACKUP_SIZE = state.COMPLETION_BACKUP_SIZE
                    module.COMPLETION_BACKUP_SHA = state.COMPLETION_BACKUP_SHA
                    module.COMPLETION_CACHE = state.COMPLETION_CACHE
                    namespace['bootstrap'].safe_open = functools.partial(state.bootstrap.safe_open, uid=os.geteuid())
                return trace
            original = state.subprocess.run
            def external(argv, **kwargs):
                if argv[:3] == ['/usr/bin/busctl', '--system', '--xml-interface']:
                    import subprocess
                    required = {'Restart':'s','KillMode':'s','RuntimeMaxUSec':'t','TimeoutStopUSec':'t',
                                'Result':'s','ExecMainCode':'i','ExecMainStatus':'i','ExecStopPost':'a(sasbttttuii)',
                                'InvocationID':'ay'}
                    xml = '<node><interface>' + ''.join('<property name="'+k+'" type="'+v+'"/>' for k,v in required.items()) + '</interface></node>'
                    return subprocess.CompletedProcess(argv, 0, xml, '')
                if argv[:2] == ['node', '-e'] or argv[:3] == ['/usr/bin/systemctl', 'show', '--all'] and 'RuntimeMaxUSec' in argv[3]:
                    import subprocess
                    return subprocess.CompletedProcess(argv, 0, '{}', '')
                return original(argv, **kwargs)
            try:
                with patch.object(sys, 'argv', ['completion-check', str(self.state), str(self.current), str(self.systemd),
                                              str(self.release), str(self.config), str(self.archive), str(self.root)]), \
                        patch.object(state.subprocess, 'run', external), \
                        patch.object(os, 'fsync', side_effect=AssertionError('readonly fsync')), \
                        patch.object(os, 'write', side_effect=AssertionError('readonly write')), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    sys.settrace(trace)
                    try:
                        exec(compile(GENERATED, '<completion-check>', 'exec'), namespace)
                    finally:
                        self.reports = [json.loads(line) for line in output.getvalue().splitlines()]
                    return {'scope': 'postmigration-independent-observation'}
            finally:
                sys.settrace(previous)
        finally:
            self.assertEqual(before, self.snapshot(), 'completion readonly check mutated state')

    # Do not inherit old repair-only tests; run that suite separately.
    @unittest.skipUnless(GENERATED is not None, 'generated entry required')
    def test_completion_existing_exclusive_lock_refuses_without_writes(self):
        lock = self.state / 'deploy.lock'
        with lock.open('rb') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.check()
        lock.unlink()
        with self.assertRaises(FileNotFoundError):
            self.check()
        self.assertFalse(lock.exists())

    def test_completion_capacity_preserves_floor_and_refuses_cache_copy(self):
        from types import SimpleNamespace
        with patch.object(state.os, 'statvfs', return_value=SimpleNamespace(f_bavail=6*1024**3+1024, f_frsize=1)):
            with self.assertRaisesRegex(ValueError, 'capacity'):
                self.check()
        Path(state.COMPLETION_CACHE).rmdir()
        with self.assertRaises(FileNotFoundError):
            self.check()

    def test_completion_capacity_devices_root_budget_not_six_gib(self):
        from types import SimpleNamespace
        # Keep real DAC/stat checks in payload admission; only capacity's device
        # observations are synthetic here. Root's reported 1.46GiB must pass;
        # release/backup must retain 6GiB after their own charged writes.
        original_stat = state.os.stat
        def stat(path, *args, **kwargs):
            actual = original_stat(path, *args, **kwargs)
            if kwargs or args:
                return actual
            values = dict((name, getattr(actual, name)) for name in dir(actual) if name.startswith('st_'))
            values['st_dev'] = 2 if str(path) in (str(self.release), str(self.root)) else 1
            return SimpleNamespace(**values)
        def space(path):
            return SimpleNamespace(f_bavail=7*1024**3 if str(path) in (str(self.release), str(self.root)) else 1460*1024**2, f_frsize=1)
        with patch.object(state.os, 'stat', stat), patch.object(state.os, 'statvfs', space):
            result = state.completion_capacity(str(self.state), str(self.release), str(self.systemd),
                                               str(self.root), str(self.archive), str(self.root))
        rows = {row['device']: row for row in result['mounts']}
        self.assertEqual(rows['1']['retainedFloorBytes'], 0)
        self.assertEqual(rows['2']['retainedFloorBytes'], 6*1024**3)
        self.assertNotIn('controlArchiveMax', rows['2']['writes'])
        self.assertIn('controlArchiveMax', rows['1']['writes'])
        self.assertIn('workerConfigurationMax', rows['2']['writes'])

    def test_completion_exact_readonly(self):
        self.assertEqual(self.check()['scope'], 'postmigration-independent-observation')

    def test_completion_python310_no_file_digest(self):
        # This suite also runs unchanged under the target's actual Python 3.10.
        # On newer test hosts, remove the 3.11-only API to exercise the failure
        # reported by the real readonly check, including the generated program.
        previous = getattr(hashlib, 'file_digest', None)
        try:
            if previous is not None:
                del hashlib.file_digest
            self.assertEqual(self.check()['scope'], 'postmigration-independent-observation')
        finally:
            if previous is not None:
                hashlib.file_digest = previous

    def test_completion_pg16_actual_version_fail_closed_before_toc(self):
        original = state.subprocess.run
        restore = '/usr/lib/postgresql/16/bin/pg_restore'
        for version, status in ((b'pg_restore (PostgreSQL) 14.20\n', 0),
                                (b'pg_restore (PostgreSQL) 17.1\n', 0),
                                (b'pg_restore (PostgreSQL) 16.11\nextra\n', 0),
                                (b'pg_restore (PostgreSQL) 16.11\n', 1)):
            calls = []
            def commands(argv, **kwargs):
                calls.append(argv)
                if argv == [restore, '--version']:
                    import subprocess
                    return subprocess.CompletedProcess(argv, status, version, b'')
                return original(argv, **kwargs)
            with self.subTest(version=version, status=status), patch.object(state.subprocess, 'run', commands):
                with self.assertRaisesRegex(ValueError, 'PostgreSQL 16'):
                    self.check()
            self.assertNotIn([restore, '--list', str(self.root / 'backup.dump')], calls)

    def test_completion_stream_hash_bounded_reads(self):
        data = b'x' * (3 * 1024 * 1024 + 19)
        class Bounded(io.BytesIO):
            def read(self, size=-1):
                if size < 0 or size > 1024 * 1024:
                    raise AssertionError('unbounded hash read')
                return super().read(size)
        self.assertEqual(state.completion_stream_sha256(Bounded(data)),
                         (len(data), hashlib.sha256(data).digest()))

    def test_completion_payload_only_forward_tar_and_chunked_files(self):
        if GENERATED is not None:
            self.skipTest('direct streaming implementation test; generated behavior covered separately')
        original_open = tarfile.open
        original_extract = tarfile.TarFile.extractfile
        class Bounded:
            def __init__(self, source):
                self.source = source
            def read(self, size=-1):
                if size < 0 or size > 1024 * 1024:
                    raise AssertionError('unbounded tar member read')
                return self.source.read(size)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.source.close()
        def opening(*args, **kwargs):
            self.assertEqual(kwargs.get('mode'), 'r|gz')
            return original_open(*args, **kwargs)
        with patch.object(tarfile, 'open', opening), \
                patch.object(tarfile.TarFile, 'getmembers', side_effect=AssertionError('random access inventory')), \
                patch.object(tarfile.TarFile, 'extractfile', lambda archive, member: Bounded(original_extract(archive, member))):
            self.check()

    def test_completion_stream_many_files_and_large_member(self):
        if GENERATED is not None:
            self.skipTest('direct multi-file stream test')
        folder = self.release / 'nested'
        folder.mkdir(mode=0o755)
        for index in range(128):
            self.write(folder / ('file-' + str(index)), 'payload-' + str(index))
        large = folder / 'large'
        large.write_bytes(b'abcd' * (1024 * 1024 + 17))
        large.chmod(0o644)
        with tarfile.open(self.archive, 'w:gz') as archive:
            archive.add(self.release / 'payload', arcname='payload')
            archive.add(folder, arcname='nested')
        with patch.object(state, 'COMPLETION_ARCHIVE_SHA', hashlib.sha256(self.archive.read_bytes()).hexdigest()):
            result = state.completion_payload(str(self.release), str(self.config), str(self.archive))
        self.assertEqual(result['memberCount'], 131)
        self.assertGreater(result['memberBytes'], 4 * 1024 * 1024)
        self.assertEqual(result['gzipInventoryPasses'], 1)

    def test_completion_payload_rejects_hardlink_and_mode_drift(self):
        payload = self.release / 'payload'
        original_mode = payload.stat().st_mode & 0o777
        payload.chmod(0o644 if original_mode != 0o644 else 0o600)
        with self.assertRaises(ValueError):
            self.check()
        payload.chmod(original_mode)
        duplicate = self.root / 'payload-hardlink'
        os.link(payload, duplicate)
        with self.assertRaises(PermissionError):
            self.check()
        duplicate.unlink()

    def test_completion_payload_rejects_unsafe_tar_inventory(self):
        # Re-sign synthetic test archives only. Real gzip digest remains fixed.
        if GENERATED is not None:
            self.skipTest('direct adversarial archive test')
        for kind in ('duplicate', 'link', 'fifo', 'traversal', 'writable', 'extra', 'missing'):
            with tarfile.open(self.archive, 'w:gz') as archive:
                if kind != 'missing':
                    archive.add(self.release / 'payload', arcname='payload')
                if kind == 'duplicate':
                    archive.add(self.release / 'payload', arcname='payload')
                elif kind != 'missing':
                    member = tarfile.TarInfo('../escape' if kind == 'traversal' else 'extra')
                    member.mode = 0o666 if kind == 'writable' else 0o644
                    member.type = tarfile.SYMTYPE if kind == 'link' else tarfile.FIFOTYPE if kind == 'fifo' else tarfile.REGTYPE
                    member.linkname = 'payload' if kind == 'link' else ''
                    archive.addfile(member, io.BytesIO(b''))
            with self.subTest(kind=kind), patch.object(state, 'COMPLETION_ARCHIVE_SHA', hashlib.sha256(self.archive.read_bytes()).hexdigest()):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.check()

    def test_completion_rejects_each_owner_pid_including_reuse(self):
        original = state.present
        for pid in (679352, 842456, 842459, 846471, 846472, 846613, 846643):
            with self.subTest(pid=pid), patch.object(state, 'present', lambda path: str(path) == '/proc/' + str(pid) or original(path)):
                with self.assertRaises(ValueError):
                    self.check()

    def test_completion_unknown_or_consumed_boundaries(self):
        for path in (self.state / 'postmigration-completion-claimed', self.state / 'protocol2-transition.json',
                     self.state / 'writer-controls', self.state / 'commit-receipts',
                     self.new / 'migration-succeeded', self.new / 'succeeded', self.new / 'to-target'):
            self.write(path, 'unknown')
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check()
            path.unlink()

    def test_completion_adoption_json_duplicates_wrong_owner_scope_extra_keys_refuse(self):
        path = self.state / 'repair-adopted'
        original = path.read_text()
        for bad in ('{}', original[:-1] + ',"owner":"duplicate"}', original.replace(state.COMPLETION_OWNER, '0' * 32),
                    original[:-1] + ',"unexpected":true}', original.replace('false', 'NaN')):
            self.write(path, bad)
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.check()
        self.write(path, original)

    def test_completion_arm_literals_cannot_be_interchanged(self):
        for name in ('forward-armed', 'migration-armed'):
            path = self.new / name
            original = path.read_text()
            self.write(path, 'wrong boundary\n')
            with self.assertRaises(ValueError):
                self.check()
            self.write(path, original)

    def test_completion_generated_four_files_are_evidence_not_exclusions(self):
        folder = self.release / 'services/parser/opening_parser/__pycache__'
        folder.mkdir(parents=True, mode=0o700)
        sizes = {'__main__.cpython-312.pyc': 11718, '__init__.cpython-312.pyc': 284,
                 'ocr.cpython-312.pyc': 6519, 'physical_pages.cpython-312.pyc': 8252}
        for name, size in sizes.items():
            (folder / name).write_bytes(b'x' * size)
            (folder / name).chmod(0o600)
        # These parent directories belong to the signed payload, unlike cache.
        with tarfile.open(self.archive, 'w:gz') as archive:
            archive.add(self.release / 'payload', arcname='payload')
            for name in ('services', 'services/parser', 'services/parser/opening_parser'):
                archive.add(self.release / name, arcname=name, recursive=False)
        patch.object(state, 'COMPLETION_ARCHIVE_SHA', hashlib.sha256(self.archive.read_bytes()).hexdigest()).start()
        before = self.snapshot()
        report = state.completion_generated_observation(str(self.release))
        self.assertFalse(report['admission'])
        self.assertFalse(report['quarantineAuthorized'])
        self.assertEqual(len(report['files']), 4)
        self.assertEqual(report['files'][0]['sha256'], hashlib.sha256(b'x' * 11718).hexdigest())
        with self.assertRaisesRegex(ValueError, 'Unknown payload deployment extra'):
            self.check()
        self.assertEqual(before, self.snapshot())
        if GENERATED is not None:
            rows = {row['readonlyProbe']: row for row in self.reports}
            self.assertTrue(rows['generated-exact-metadata-hashes-NOT-admission']['ok'])
            self.assertFalse(rows['payload']['ok'])
            for name in ('both-historical-units', 'capacity', 'database-exact110-quiet',
                         'capabilities-aistudy-web.service', 'capabilities-aistudy-worker.service'):
                self.assertTrue(rows[name]['ok'], name)
        self.write(folder / 'arbitrary.pyc', 'extra')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            state.completion_generated_observation(str(self.release))

    def test_completion_payload_extra_link_bytes_mode_digest_refuse(self):
        extra = self.release / 'unknown'
        self.write(extra, 'not signed')
        with self.assertRaises(ValueError):
            self.check()
        extra.unlink()
        payload = self.release / 'payload'
        original = payload.read_text()
        self.write(payload, 'changed')
        with self.assertRaises(ValueError):
            self.check()
        self.write(payload, original)
        (self.release / '.env.production').unlink()
        (self.release / '.env.production').symlink_to(self.old)
        with self.assertRaises(ValueError):
            self.check()

    def test_completion_new_wrapper_or_unknown_broker_refuse(self):
        original = state.present
        with patch.object(state, 'present', lambda path: str(path) == '/run/aistudy-writer-broker' or original(path)):
            with self.assertRaises(ValueError):
                self.check()
        self.write(self.systemd / (state.WORKER + '.d') / '96-aistudy-writer-exec.conf', '[Service]\n')
        with self.assertRaises(ValueError):
            self.check()


if __name__ == '__main__':
    # Select only completion tests rather than executing the inherited repair suite.
    suite = unittest.TestSuite(Completion(name) for name in dir(Completion) if name.startswith('test_completion_'))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
