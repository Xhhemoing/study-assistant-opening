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
COMPLETION_MANAGER = state.completion_manager
COMPLETION_SCOPE = state.completion_scope
import subprocess
REAL_SUBPROCESS_RUN = subprocess.run
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
                                'Result':'s','ExecMainPID':'u','ExecMainCode':'i','ExecMainStatus':'i','ExecStopPost':'a(sasbttttuii)',
                                'InvocationID':'ay'}
                    xml = '<node><interface>' + ''.join('<property name="'+k+'" type="'+v+'"/>' for k,v in required.items()) + '</interface></node>'
                    return subprocess.CompletedProcess(argv, 0, xml, '')
                if argv[:2] == ['node', '-e']:
                    self.database_probed = True
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

    def test_completion_config_dac_refuses_before_database_or_claim(self):
        original = self.config.read_bytes()
        for kind in ('symlink', 'wrongowner', 'writable', 'hardlink', 'ancestor'):
            self.database_probed = False
            real_fstat = os.fstat
            def fstat(fd):
                st = real_fstat(fd)
                if kind == 'wrongowner' and os.readlink('/proc/self/fd/' + str(fd)) == str(self.config):
                    from types import SimpleNamespace
                    values = {name: getattr(st, name) for name in dir(st) if name.startswith('st_')}
                    values['st_uid'] = os.geteuid() + 1
                    return SimpleNamespace(**values)
                return st
            other = self.root / 'other-config'
            if kind == 'symlink':
                self.config.rename(other)
                self.config.symlink_to(other)
            elif kind == 'hardlink':
                os.link(self.config, other)
            elif kind == 'writable':
                self.config.chmod(0o620)
            elif kind == 'ancestor':
                self.root.chmod(0o720)
            try:
                with self.subTest(kind=kind), patch.object(os, 'fstat', fstat):
                    with self.assertRaises((PermissionError, OSError)):
                        self.check()
                    self.assertFalse(self.database_probed)
                    self.assertFalse((self.state / 'postmigration-completion-claimed').exists())
            finally:
                self.root.chmod(0o700)
                if kind == 'symlink':
                    self.config.unlink()
                    other.rename(self.config)
                elif kind == 'hardlink':
                    other.unlink()
                self.config.chmod(0o600)
                self.assertEqual(self.config.read_bytes(), original)

    def test_completion_claim_origin_exclusive_partial_faults_and_unknown_inode(self):
        if GENERATED is not None:
            return  # Generated precheck is readonly; creation covered directly.
        import tempfile
        # Container overlayfs lacks O_TMPFILE; use real Linux tmpfs rather than
        # mocking exclusive inode publication. Runtime proof stays on /tmp,
        # deliberately a different filesystem from this synthetic state.
        anonymous_state = tempfile.TemporaryDirectory(prefix='completion-inode-', dir='/dev/shm')
        self.addCleanup(anonymous_state.cleanup)
        self.state = Path(anonymous_state.name)
        context = self.root / 'runtime'
        context.mkdir(mode=0o700)
        claim = self.state / 'postmigration-completion-claimed'
        scope = {'invocation': 'a' * 32, 'owner': 'b' * 32, 'mainPid': '1234', 'release': str(self.release)}
        with patch.object(state, 'COMPLETION_CONTEXT', str(context)):
            for contents in ('', '{broken'):
                self.write(claim, contents)
                with self.assertRaises(FileExistsError):
                    state.create_completion_claim(str(self.state), scope)
                with self.assertRaises(ValueError):
                    state.completion_origin(str(self.state))
                self.assertEqual(claim.read_text(), contents)
                claim.unlink()
                (context / 'claim-origin.json').unlink()
            for fault in ('none', 'link-ack', 'write', 'fsync', 'directory-fsync'):
                original_fsync, original_fdopen, original_link = os.fsync, os.fdopen, os.link
                def link(*args, **kwargs):
                    original_link(*args, **kwargs)
                    if fault == 'link-ack':
                        raise OSError('injected lost link ACK')
                def fsync(fd):
                    path = os.readlink('/proc/self/fd/' + str(fd))
                    if (fault == 'fsync' and '/#' in path or
                            fault == 'directory-fsync' and path == str(self.state)):
                        raise OSError('injected claim fsync fault')
                    return original_fsync(fd)
                def fdopen(fd, *args, **kwargs):
                    if fault == 'write' and '/#' in os.readlink('/proc/self/fd/' + str(fd)):
                        os.close(fd)
                        raise OSError('injected claim write fault')
                    return original_fdopen(fd, *args, **kwargs)
                with self.subTest(fault=fault), patch.object(os, 'fsync', fsync), patch.object(os, 'fdopen', fdopen), patch.object(os, 'link', link):
                    if fault == 'none':
                        state.create_completion_claim(str(self.state), scope)
                    else:
                        with self.assertRaises(OSError):
                            state.create_completion_claim(str(self.state), scope)
                proof = state.completion_origin(str(self.state))
                self.assertEqual(proof['invocation'], scope['invocation'])
                self.assertEqual(proof['mainPid'], scope['mainPid'])
                self.assertEqual(proof['claimInode'], claim.stat().st_ino)
                # Keep the old inode allocated so replacement cannot reuse it.
                held = os.open(claim, os.O_RDONLY)
                try:
                    claim.unlink()
                    self.write(claim, '')
                    with self.assertRaises(ValueError):
                        state.completion_origin(str(self.state))
                    claim.unlink()
                finally:
                    os.close(held)
                (context / 'claim-origin.json').unlink()
            # Origin persistence failure is before claim publication, even if
            # the partial runtime file remains for independent inspection.
            with patch.object(os, 'fsync', side_effect=OSError('runtime origin fsync')):
                with self.assertRaises(OSError):
                    state.create_completion_claim(str(self.state), scope)
            self.assertFalse(claim.exists())
            with self.assertRaises(FileNotFoundError):
                state.completion_origin(str(self.state))

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

    def reload_fixture(self, real_scope=True):
        directory = self.root / 'reload-evidence'
        quarantine = self.root / 'quarantine'
        entry = self.root / 'retained-entry'
        entry.mkdir(mode=0o700)
        unit = self.root / 'completion.service'
        self.write(unit, 'exact retained unit')
        self.write(entry / 'control', 'exact 205 bytes')
        manager = {'Id': state.COMPLETION_UNIT, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                   'MainPID': '0', 'ControlPID': '0', 'ExecMainPID': '0', 'ExecMainStartTimestampMonotonic': '0',
                   'ExecMainExitTimestampMonotonic': '0', 'ActiveEnterTimestampMonotonic': '0', 'InactiveExitTimestampMonotonic': '0',
                   'ExecMainCode': '0', 'ExecMainStatus': '0', 'InvocationID': '', 'NRestarts': '0', 'Job': '',
                   'Result': 'success', 'FragmentPath': str(unit), 'DropInPaths': '', 'NeedDaemonReload': 'no'}
        args = ['complete-postmigration', str(self.root), '/releases', str(self.current), str(self.state),
                '/backups', str(self.systemd), str(self.root), '6291456', state.COMPLETION_SHA,
                str(self.release), state.COMPLETION_ARCHIVE_SHA, str(self.archive)]
        payload = {'args': args, 'unit': 'new reviewed unit', 'retainedUnit': 'exact retained unit', 'phase': 'absent'}
        for key, value in {'COMPLETION_ADMISSION': str(directory), 'COMPLETION_QUARANTINE': str(quarantine),
                           'COMPLETION_RETAINED_ENTRY': str(entry), 'COMPLETION_UNIT_PATH': str(unit),
                           'COMPLETION_205': {'control': hashlib.sha256(b'exact 205 bytes').hexdigest()}}.items():
            patch.object(state, key, value).start()
        patch.object(state, 'completion_controls', return_value={'reviewed': 'new-controls'}).start()
        patch.object(state, 'completion_manager', return_value=manager).start()
        self.write(self.root / '.env.production', self.config.read_text())
        self.reload_external = state.subprocess.run
        return payload, manager, directory, quarantine, unit

    def reload_result(self, argv, **kwargs):
        if argv == ['/usr/bin/systemctl', 'daemon-reload']:
            import subprocess
            return subprocess.CompletedProcess(argv, 0)
        return self.reload_external(argv, **kwargs)

    def test_completion_reload_three_samples_half_bound_and_retained_archive(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        import subprocess
        ticks = iter([100, 30_000_000_100, 30_000_000_101, 60_000_000_101, 60_000_000_102, 90_000_000_102])
        calls = []
        def run(argv, **kwargs):
            if argv == ['/usr/bin/systemctl', 'daemon-reload']:
                calls.append((argv, kwargs))
            return self.reload_result(argv, **kwargs)
        with patch.object(state.time, 'monotonic_ns', side_effect=lambda: next(ticks)), patch.object(state.subprocess, 'run', run):
            state.completion_reload_samples(payload)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(argv == ['/usr/bin/systemctl', 'daemon-reload'] and kw['timeout'] == 60 for argv, kw in calls))
        with patch.object(state.time, 'monotonic_ns', return_value=90_000_000_103):
            state.completion_reload_admission(payload['args'])
            for index in range(3):
                sample = directory / ('sample-' + str(index) + '.json')
                self.assertEqual(sample.stat().st_mode & 0o777, 0o600)
            # Any claimed/partial attempt prevents archive, without unit mutation.
            self.write(self.state / 'postmigration-completion-claimed', '{partial')
            with self.assertRaises(ValueError):
                state.completion_retained_archive(payload)
            (self.state / 'postmigration-completion-claimed').unlink()
            for key, value in [('ExecMainStartTimestampMonotonic', '1'), ('InvocationID', 'a'*32), ('ExecMainPID', '123'), ('NRestarts', '1')]:
                with patch.object(state, 'completion_manager', return_value={**manager, key: value}):
                    with self.assertRaises(ValueError):
                        state.completion_retained_archive(payload)
                self.assertTrue(unit.exists())
                self.assertFalse(quarantine.exists())
            self.assertTrue(state.completion_retained_archive(payload)['archived'])
            self.assertFalse(unit.exists())
            self.assertEqual((quarantine / state.COMPLETION_UNIT).read_bytes(), b'exact retained unit')
            self.assertEqual((quarantine / 'manifest.json').stat().st_mode & 0o777, 0o600)
            state.completion_launch_check(payload)
            with self.assertRaises(ValueError):
                state.completion_reload_samples(payload)  # Never overwrite prior attempt evidence.

    def test_completion_reload_missing_slow_failed_stale_evidence_never_admits(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        before = unit.read_bytes()
        with self.assertRaises(FileNotFoundError):
            state.completion_reload_admission(payload['args'])
        import subprocess
        ticks = iter([100, 30_000_000_101])
        with patch.object(state.time, 'monotonic_ns', side_effect=lambda: next(ticks)), \
                patch.object(state.subprocess, 'run', self.reload_result):
            with self.assertRaisesRegex(ValueError, 'Reload admission failed'):
                state.completion_reload_samples(payload)
        self.assertEqual(unit.read_bytes(), before)
        row = json.loads((directory / 'sample-0.json').read_text())
        self.assertEqual(row['elapsedNs'], 30_000_000_001)
        with self.assertRaises(ValueError):
            state.completion_reload_admission(payload['args'])
        self.assertFalse(quarantine.exists())

    def test_completion_reload_evidence_status_age_scope_and_three_samples(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        import subprocess
        ticks = iter([100, 200, 201, 300, 301, 400])
        with patch.object(state.time, 'monotonic_ns', side_effect=lambda: next(ticks)), \
                patch.object(state.subprocess, 'run', self.reload_result):
            state.completion_reload_samples(payload)
        sample = directory / 'sample-1.json'
        original = sample.read_text()
        variants = [{'exit': 1}, {'elapsedNs': 30000000001}, {'boundNs': 20000000000},
                    {'index': 0}, {'boot': 'other-boot'}, {'after': {**manager, 'InvocationID': 'a'*32}}]
        for variant in variants:
            sample.write_text(json.dumps({**json.loads(original), **variant}))
            with patch.object(state.time, 'monotonic_ns', return_value=401), self.assertRaises(ValueError):
                state.completion_reload_admission(payload['args'])
        sample.write_text(original)
        with patch.object(state.time, 'monotonic_ns', return_value=state.RELOAD_EVIDENCE_AGE_NS + 401), self.assertRaises(ValueError):
            state.completion_reload_admission(payload['args'])
        sample.unlink()
        with patch.object(state.time, 'monotonic_ns', return_value=401), self.assertRaises(FileNotFoundError):
            state.completion_reload_admission(payload['args'])
        self.assertTrue(unit.exists())
        self.assertFalse(quarantine.exists())

    def test_completion_retained_wrong_bytes_archive_failure_and_claim_race(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        with patch.object(state, 'completion_reload_admission'):
            self.write(unit, 'arbitrary unit')
            with self.assertRaisesRegex(ValueError, 'Retained unit differs'):
                state.completion_retained_archive(payload)
            self.assertFalse(quarantine.exists())
            self.write(unit, 'exact retained unit')
            original_scope = state.completion_scope
            calls = [0]
            def race(value):
                calls[0] += 1
                if calls[0] == 2:
                    self.write(self.state / 'postmigration-completion-claimed', '{partial')
                return original_scope(value)
            with patch.object(state, 'completion_scope', side_effect=race), self.assertRaises(ValueError):
                state.completion_retained_archive(payload)
            self.assertTrue(unit.exists())
            self.assertFalse(quarantine.exists())
            (self.state / 'postmigration-completion-claimed').unlink()
            with patch.object(state.os, 'rename', side_effect=OSError('archive failed')), self.assertRaises(OSError):
                state.completion_retained_archive(payload)
            self.assertTrue(unit.exists())
            self.assertTrue((quarantine / 'manifest.json').exists())
            with self.assertRaises(FileNotFoundError):
                state.completion_launch_check(payload)

    def test_completion_reload_nonzero_timeout_and_postquery_failure_retain_partial(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        import subprocess
        def fail(argv, **kwargs):
            if argv == ['/usr/bin/systemctl', 'daemon-reload']:
                raise subprocess.TimeoutExpired(argv, 60)
            return self.reload_external(argv, **kwargs)
        ticks = iter([100, 60_000_000_100])
        # Failed post-query must not lose the actual reload timeout evidence.
        with patch.object(state.time, 'monotonic_ns', side_effect=lambda: next(ticks)), \
                patch.object(state.subprocess, 'run', fail), \
                patch.object(state, 'completion_manager', side_effect=[manager, manager, OSError('query failed')]):
            with self.assertRaises(ValueError):
                state.completion_reload_samples(payload)
        self.assertTrue((directory / 'sample-0-started.json').exists())
        sample = json.loads((directory / 'sample-0.json').read_text())
        self.assertEqual(sample['error'], 'TimeoutExpired')
        self.assertIsNone(sample['exit'])
        self.assertEqual(sample['after'], {'observationError': 'OSError'})
        self.assertFalse((directory / 'sample-1-started.json').exists())
        self.assertTrue(unit.exists())
        self.assertFalse(quarantine.exists())

    def test_completion_manager_requires_complete_unambiguous_actual_observation(self):
        import subprocess
        # The fixture manager mock is NOT used here: exercise real parser, fake subprocess only.
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        raw = '\n'.join(k + '=' + v for k, v in manager.items()) + '\n'
        actual = COMPLETION_MANAGER
        with patch.object(state.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, raw, '')):
            self.assertEqual(actual(), manager)
        for invalid in (raw + 'MainPID=0\n', raw.replace('MainPID=0\n', ''), raw + 'garbage\n'):
            with patch.object(state.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, invalid, '')), self.assertRaises(ValueError):
                actual()

    def test_completion_review_real_scope_rejects_effective_missing_fence(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture(real_scope=True)
        self.conditions['aistudy-web.service'] = []
        before = self.snapshot()
        with self.assertRaises(ValueError):
            COMPLETION_SCOPE(payload)
        self.assertEqual(before, self.snapshot())

    def test_completion_review_real_scope_each_operation_rejects_writer_or_job_without_mutation(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture(real_scope=True)
        operations = (state.completion_reload_samples, state.completion_retained_archive, state.completion_launch_check)
        for unit_name in self.values:
            for key, bad in [('MainPID', '42'), ('Job', '7'), ('NeedDaemonReload', 'yes')]:
                original = self.stopped[unit_name][key]
                self.stopped[unit_name][key] = bad
                before = self.snapshot()
                for operation in operations:
                    with self.assertRaises((ValueError, PermissionError)):
                        operation(payload)
                    self.assertEqual(before, self.snapshot())
                self.stopped[unit_name][key] = original
        self.conditions['aistudy-web.service'] = []
        before = self.snapshot()
        for operation in operations:
            with self.assertRaises(ValueError):
                operation(payload)
            self.assertEqual(before, self.snapshot())

    def test_completion_review_real_scope_manager_query_failure_and_unlisted_dropin_zero_mutation(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture(real_scope=True)
        operations = (state.completion_reload_samples, state.completion_retained_archive, state.completion_launch_check)
        before = self.snapshot()
        with patch.object(state.subprocess, 'run', side_effect=OSError('manager unavailable')):
            for operation in operations:
                with self.assertRaises(OSError):
                    operation(payload)
                self.assertEqual(before, self.snapshot())
        extra = self.systemd / (state.WORKER + '.d') / '99-unreviewed.conf'
        self.write(extra, '[Service]\\nRestart=always\\n')
        self.values[state.WORKER]['DropInPaths'] += ' ' + str(extra)
        before = self.snapshot()
        for operation in operations:
            with self.assertRaises(ValueError):
                operation(payload)
            self.assertEqual(before, self.snapshot())

    def test_completion_review_real_scope_nonempty_cgroup_zero_mutation(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture(real_scope=True)
        group = '/sys/fs/cgroup/synthetic-writer'
        self.stopped[state.WORKER]['ControlGroup'] = '/synthetic-writer'
        original_read = Path.read_text
        def read(path, *args, **kwargs):
            if str(path) == group + '/cgroup.procs':
                return '42\\n'
            return original_read(path, *args, **kwargs)
        before = self.snapshot()
        with patch.object(state.os, 'walk', return_value=[(group, [], ['cgroup.procs'])]), patch.object(Path, 'read_text', read):
            for operation in (state.completion_reload_samples, state.completion_retained_archive, state.completion_launch_check):
                with self.assertRaisesRegex(ValueError, 'Writer cgroup not empty'):
                    operation(payload)
                self.assertEqual(before, self.snapshot())

    def test_completion_review_real_scope_sample_post_reload_writer_appears(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture(real_scope=True)
        external = state.subprocess.run
        import subprocess
        calls = []
        def command(argv, **kwargs):
            if argv == ['/usr/bin/systemctl', 'daemon-reload']:
                calls.append(argv)
                self.stopped[state.WORKER]['MainPID'] = '42'
                return subprocess.CompletedProcess(argv, 0)
            return external(argv, **kwargs)
        with patch.object(state.subprocess, 'run', command), self.assertRaises(ValueError):
            state.completion_reload_samples(payload)
        self.assertEqual(len(calls), 1)
        self.assertTrue((directory / 'sample-0.json').exists())
        self.assertFalse((directory / 'sample-1-started.json').exists())
        self.assertTrue(unit.exists())
        self.assertFalse(quarantine.exists())

    def test_completion_review_real_scope_sample_pre_reload_fence_removed(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture(real_scope=True)
        original_write = state.completion_private_write
        def write(path, value):
            original_write(path, value)
            if Path(path).name == 'scope.json':
                self.conditions[state.WORKER] = []
        with patch.object(state, 'completion_private_write', write), self.assertRaises(ValueError):
            state.completion_reload_samples(payload)
        self.assertFalse((directory / 'sample-0-started.json').exists())
        self.assertTrue(unit.exists())

    def test_completion_review_archive_same_bytes_new_inode_refused(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        with patch.object(state, 'completion_reload_admission'):
            state.completion_retained_archive(payload)
            archived = quarantine / state.COMPLETION_UNIT
            replacement = quarantine / 'replacement'
            self.write(replacement, archived.read_text())
            os.replace(replacement, archived)
            with self.assertRaises(ValueError):
                state.completion_launch_check(payload)

    def test_completion_review_archive_parent_inode_and_partial_proof_refused(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        with patch.object(state, 'completion_reload_admission'):
            state.completion_retained_archive(payload)
            # Same contents and original archived file inode do not authorize a
            # replacement quarantine parent. Move, do not delete, old evidence.
            saved = quarantine.with_name('quarantine-original')
            quarantine.rename(saved)
            quarantine.mkdir(mode=0o700)
            for path in saved.iterdir():
                path.rename(quarantine / path.name)
            with self.assertRaisesRegex(ValueError, 'identity changed'):
                state.completion_launch_check(payload)

    def test_completion_review_archive_after_rename_replacement_never_gets_identity_proof(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        rename = state.os.rename
        def substituted(source, destination):
            rename(source, destination)
            other = Path(destination).with_name('substitute')
            self.write(other, Path(destination).read_text())
            os.replace(other, destination)
        with patch.object(state, 'completion_reload_admission'), patch.object(state.os, 'rename', substituted):
            with self.assertRaisesRegex(ValueError, 'changed during archive'):
                state.completion_retained_archive(payload)
        self.assertTrue((quarantine / 'manifest.json').exists())
        self.assertFalse((quarantine / 'archive-identity.json').exists())
        with patch.object(state, 'completion_reload_admission'), self.assertRaises(FileNotFoundError):
            state.completion_launch_check(payload)

    def test_completion_review_archived_external_reload_strict_notfound_admitted(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        with patch.object(state, 'completion_reload_admission'):
            state.completion_retained_archive(payload)
            unloaded = {**manager, 'LoadState': 'not-found', 'FragmentPath': ''}
            with patch.object(state, 'completion_manager', return_value=unloaded):
                self.assertTrue(state.completion_launch_check(payload)['admitted'])
                self.assertTrue(state.completion_launch_check({**payload, 'phase': 'unloaded'})['admitted'])

    def test_completion_review_archived_notfound_started_claimed_fragment_refused(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        with patch.object(state, 'completion_reload_admission'):
            state.completion_retained_archive(payload)
            unloaded = {**manager, 'LoadState': 'not-found', 'FragmentPath': ''}
            for key, value in [('FragmentPath', '/unreviewed/unit'), ('InvocationID', 'a'*32),
                               ('ExecMainStartTimestampMonotonic', '1'), ('ExecMainExitTimestampMonotonic', '1'),
                               ('MainPID', '42'), ('Job', '7'), ('NeedDaemonReload', 'yes'),
                               ('DropInPaths', '/unreviewed/dropin'), ('ControlPID', '42')]:
                with patch.object(state, 'completion_manager', return_value={**unloaded, key: value}):
                    with self.assertRaises(ValueError):
                        state.completion_launch_check(payload)
            self.write(self.state / 'postmigration-completion-claimed', '{partial')
            with patch.object(state, 'completion_manager', return_value=unloaded), self.assertRaises(ValueError):
                state.completion_launch_check(payload)

    def test_completion_review_loop_deleted_incident_fence_stops_before_next_reload(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        calls = []
        def command(argv, **kwargs):
            if argv == ['/usr/bin/systemctl', 'daemon-reload']:
                import subprocess
                calls.append(argv)
                (self.state / 'writers-fenced').unlink()
                return subprocess.CompletedProcess(argv, 0)
            return self.reload_external(argv, **kwargs)
        with patch.object(state.subprocess, 'run', command), self.assertRaises((ValueError, OSError)):
            state.completion_reload_samples(payload)
        self.assertEqual(len(calls), 1)
        self.assertTrue((directory / 'sample-0.json').exists())
        self.assertFalse((directory / 'sample-1-started.json').exists())

    def test_completion_review_loop_incident_changes_preserve_partial_stop_mutation(self):
        for changed in ('guard', 'current', 'adoption', 'activation', 'backup', 'query'):
            with self.subTest(changed=changed):
                # Each variant runs under a fresh real incident fixture, never a
                # stubbed scope. Restore its inputs before the next variant.
                payload, manager, directory, quarantine, unit = self.reload_fixture()
                calls = []
                originals = {}
                for path in (self.state / 'migration-forward-only', self.state / 'repair-adopted',
                             self.state / 'activation-incomplete', self.new / 'database-backup'):
                    originals[path] = path.read_bytes()
                old_current = os.readlink(self.current)
                def command(argv, **kwargs):
                    if argv == ['/usr/bin/systemctl', 'daemon-reload']:
                        import subprocess
                        calls.append(argv)
                        targets = {'guard': self.state / 'migration-forward-only',
                                   'adoption': self.state / 'repair-adopted',
                                   'activation': self.state / 'activation-incomplete',
                                   'backup': self.new / 'database-backup'}
                        if changed in targets: self.write(targets[changed], 'changed binding')
                        if changed == 'current':
                            self.current.unlink(); self.current.symlink_to(self.release)
                        return subprocess.CompletedProcess(argv, 0)
                    if calls and changed == 'query': raise OSError('manager unavailable')
                    return self.reload_external(argv, **kwargs)
                try:
                    with patch.object(state.subprocess, 'run', command), self.assertRaises((ValueError, OSError)):
                        state.completion_reload_samples(payload)
                    self.assertEqual(len(calls), 1)
                    self.assertTrue((directory / 'sample-0.json').exists())
                    self.assertFalse((directory / 'sample-1-started.json').exists())
                    self.assertTrue(unit.exists())
                    self.assertFalse(quarantine.exists())
                finally:
                    for path, contents in originals.items(): path.write_bytes(contents)
                    self.current.unlink(); self.current.symlink_to(old_current)
                    # Only synthetic files; all object patches unwind in tearDown.
                    import shutil
                    shutil.rmtree(directory)
                    unit.unlink()
                    shutil.rmtree(self.root / 'retained-entry')

    def test_completion_review_real_claim_admission_fresh_expired_boot_controls_and_lock_race(self):
        payload, manager, directory, quarantine, unit = self.reload_fixture()
        ticks = iter([100, 200, 201, 300, 301, 400])
        with patch.object(state.time, 'monotonic_ns', side_effect=lambda: next(ticks)), patch.object(state.subprocess, 'run', self.reload_result):
            state.completion_reload_samples(payload)
        with patch.object(state.time, 'monotonic_ns', return_value=401):
            state.completion_retained_archive(payload)
            self.write(unit, payload['unit'])
            claim_payload = {**payload, 'phase': 'claim'}
            # Real admission on the claim branch, with the same exclusive lock
            # held as production; no bypass through a no-op scope adapter.
            with (self.state / 'deploy.lock').open('rb') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertTrue(state.completion_launch_check(claim_payload)['admitted'])
                contender = REAL_SUBPROCESS_RUN([sys.executable, '-I', '-S', '-B', '-c',
                    'import fcntl,sys; f=open(sys.argv[1],"rb"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',
                    str(self.state / 'deploy.lock')], capture_output=True)
                self.assertNotEqual(contender.returncode, 0)
            header = directory / 'scope.json'
            original = header.read_text()
            for changed in ({'boot': 'different-boot'}, {'controls': {'other-head': 'changed'}}):
                header.write_text(json.dumps({**json.loads(original), **changed}))
                with self.assertRaises(ValueError): state.completion_launch_check(claim_payload)
            header.write_text(original)
            with patch.object(state.time, 'monotonic_ns', return_value=state.RELOAD_EVIDENCE_AGE_NS + 401), self.assertRaises(ValueError):
                state.completion_launch_check(claim_payload)
            self.write(self.state / 'postmigration-completion-claimed', '{race')
            with self.assertRaises(ValueError): state.completion_launch_check(claim_payload)

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
