"""Local kernel/process/filesystem tests; no systemd, DB, VM or paid API."""
import copy
import errno
import importlib.util
import io
import json
import multiprocessing
import py_compile
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import tarfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'infra/deploy'


# Bootstrap is the trusted entry in production; only tests explicitly replace
# its UID object. Siblings are never imported using Python's bytecode loader.
bootstrap_spec = importlib.util.spec_from_file_location('trusted_bootstrap', ROOT / 'hermes-trusted-loader.py')
bootstrap = importlib.util.module_from_spec(bootstrap_spec)
bootstrap_spec.loader.exec_module(bootstrap)
bootstrap.TRUSTED_UID = os.geteuid()
loader = bootstrap.SourceLoader(ROOT)


def load(name):
    return loader.load(name + '.py')


state = load('hermes-writer-state')
peer = load('hermes-peer-broker')


def setUpModule():
    if sys.platform != 'linux' or not all((hasattr(os, 'pidfd_open'),
            hasattr(signal, 'pidfd_send_signal'), hasattr(socket, 'SO_PEERCRED'))):
        raise unittest.SkipTest('Linux SO_PEERCRED and pidfd APIs required')
    # Probe actual kernel support, not just Python API availability. Unexpected
    # errors and all subsequent test failures remain failures, never skips.
    unavailable = {errno.ENOSYS, errno.EOPNOTSUPP, errno.EPERM, errno.EACCES}
    try:
        fd = os.pidfd_open(os.getpid())
        try:
            signal.pidfd_send_signal(fd, 0)
        finally:
            os.close(fd)
        left, right = socket.socketpair(socket.AF_UNIX)
        with left, right:
            credentials = struct.unpack('3i', left.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if credentials != (os.getpid(), os.geteuid(), os.getegid()):
                raise AssertionError('SO_PEERCRED did not report actual process credentials')
    except OSError as error:
        if error.errno in unavailable:
            raise unittest.SkipTest(f'Kernel peercred/pidfd unavailable: {error}') from error
        raise


class Fixture(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        patch.object(state, 'TRUSTED_UID', os.geteuid()).start()
        patch.object(peer.state_api, 'TRUSTED_UID', os.geteuid()).start()
        self.temporary = tempfile.TemporaryDirectory(prefix='hermes-writer-')
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.target = self.root / 'target'
        self.target.mkdir()
        self.current = self.root / 'current'
        self.current.symlink_to(self.target)
        self.broker_path = self.root / 'exec.sock'
        self.config = self.root / 'config'
        self.config.write_text('trusted\n')
        self.config.chmod(0o600)
        st = self.target.stat()
        self.binding = {'protocol': 2, 'owner': 'a' * 32, 'transition': str(self.root / 'transition'),
                        'action': 'deploy', 'target': str(self.target), 'targetIdentity': [st.st_dev, st.st_ino],
                        'config': {'files': [{'path': str(self.config), 'identity': state.identity(self.config.stat())}]}}
        state.durable_write(self.root / 'protocol2-transition.json', self.binding)
        for name in ('activation-incomplete', 'migration-forward-only', 'writers-fenced'):
            (self.root / name).write_text('fenced')
        self.addCleanup(self.temporary.cleanup)

    def classify(self, **kwargs):
        return state.classify(self.root, self.current, self.broker_path, **kwargs)

    def commit(self):
        state.commit(self.root, self.current, self.broker_path, self.binding)


class TrustedSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hermes-sources-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        for name in bootstrap.SOURCES:
            (self.root / name).write_text('loaded = True\n')
        self.loader = bootstrap.SourceLoader(self.root)
        self.marker = self.root / 'executed'

    def malicious(self, name='hermes-peer-broker.py'):
        path = self.root / name
        path.write_text('from pathlib import Path\nPath(' + repr(str(self.marker)) + ').touch()\n')
        return path

    def test_complete_inventory_checked_before_top_level_effect(self):
        source = self.malicious()
        for defect in ('missing', 'symlink', 'hardlink', 'writable', 'parent', 'owner'):
            with self.subTest(defect=defect):
                other = self.root / 'hermes-writer-state.py'
                original = other.read_bytes()
                if defect == 'missing':
                    other.unlink()
                elif defect == 'symlink':
                    other.unlink(); other.symlink_to(source)
                elif defect == 'hardlink':
                    other.unlink(); os.link(source, other)
                elif defect == 'writable':
                    other.chmod(0o666)
                elif defect == 'parent':
                    self.root.chmod(0o777)
                try:
                    uid = 0 if os.geteuid() != 0 else 12345
                    with patch.object(bootstrap, 'TRUSTED_UID', uid if defect == 'owner' else os.geteuid()):
                        with self.assertRaises((OSError, ValueError)):
                            self.loader.load(source.name)
                    self.assertFalse(self.marker.exists())
                finally:
                    self.root.chmod(0o700)
                    if other.exists() or other.is_symlink():
                        other.unlink()
                    other.write_bytes(original)

    def test_valid_source_cache_and_identity_change_refusal(self):
        source = self.root / 'hermes-peer-broker.py'
        module = self.loader.load(source.name)
        self.assertTrue(module.loaded)
        self.assertIs(self.loader.load(source.name), module)
        self.malicious()
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.loader.load(source.name)
        self.assertFalse(self.marker.exists())

    def test_matching_timestamp_and_size_malicious_pyc_never_read_or_written(self):
        source = self.malicious()
        bad = source.read_bytes()
        py_compile.compile(str(source), doraise=True)
        cached = Path(importlib.util.cache_from_source(str(source)))
        before = cached.read_bytes()
        timestamp = source.stat().st_mtime_ns
        source.write_bytes(b'loaded = True\n' + b'#' * (len(bad) - len(b'loaded = True\n')))
        os.utime(source, ns=(timestamp, timestamp))
        self.assertTrue(self.loader.load(source.name).loaded)
        self.assertFalse(self.marker.exists())
        self.assertEqual(cached.read_bytes(), before)
        self.assertEqual(list((self.root / '__pycache__').iterdir()), [cached])
        source.unlink()
        with self.assertRaises(FileNotFoundError):
            bootstrap.SourceLoader(self.root).load(source.name)
        self.assertFalse(self.marker.exists())

    def test_production_source_dac_rejects_uid1000_without_object_injection(self):
        if os.geteuid() == 0:
            self.skipTest('requires unprivileged fixture owner')
        with patch.object(bootstrap, 'TRUSTED_UID', 0):
            with self.assertRaises(PermissionError):
                self.loader.load('hermes-writer-state.py')

    def test_config_identity_and_source_dac_checked_before_manager_module_effect(self):
        (self.root / 'hermes-writer-state.py').write_bytes((ROOT / 'hermes-writer-state.py').read_bytes())
        broker = self.malicious()
        api = self.loader.load('hermes-writer-state.py')
        config = self.root / 'config'
        config.write_text('trusted')
        identity = bootstrap.identity(config.stat())
        config.write_text('changed configuration bytes')
        with patch.object(api, 'TRUSTED_UID', os.geteuid()):
            with self.assertRaisesRegex(ValueError, 'Configuration identity changed'):
                api.validate_config({'files': [{'path': str(config), 'identity': identity}], 'effective': {}})
            broker.chmod(0o666)
            with self.assertRaises(PermissionError):
                api.validate_config({'files': [], 'effective': {}})
        self.assertFalse(self.marker.exists())

    def test_verify_is_strict_inventory_only_and_never_dispatches_sibling(self):
        self.malicious()
        with patch.object(bootstrap, '__file__', str(self.root / 'hermes-trusted-loader.py')):
            with patch.object(sys, 'argv', ['loader', 'verify']), patch.object(bootstrap.SourceLoader, 'load', side_effect=AssertionError('sibling dispatched')):
                bootstrap.main()
            self.assertFalse(self.marker.exists())
            with patch.object(sys, 'argv', ['loader', 'verify', 'state']):
                with self.assertRaisesRegex(ValueError, 'no arguments'):
                    bootstrap.main()
            with patch.object(sys, 'argv', ['loader', 'unknown']):
                with self.assertRaises(KeyError):
                    bootstrap.main()

    def test_state_and_wrapper_share_verified_loader_not_importlib(self):
        actual = bootstrap.SourceLoader(ROOT)
        wrapper = actual.load('hermes-writer-exec.py')
        broker = wrapper.controls()
        self.assertIs(broker.state_api, actual.load('hermes-writer-state.py'))
        self.assertIs(broker.trusted_loader, wrapper.trusted_loader)


class EntryTransportTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('entry_transport', ROOT / 'hermes-entry.py')
        self.entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.entry)
        self.temp = tempfile.TemporaryDirectory(prefix='hermes-entry-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o770)
        self.source.chmod(0o770)
        self.contents = {}
        for index, name in enumerate(self.entry.FILES):
            data = (ROOT / name).read_bytes()
            self.contents[name] = data
            (self.source / name).write_bytes(data)
            (self.source / name).chmod(0o775 if index % 2 else 0o664)
        self.destination = self.root / 'destination'
        self.destination.mkdir(mode=0o700)

    def archive(self):
        result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', str(ROOT / 'hermes-entry.py'),
                                 'pack', str(self.source)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_real_tar_normalizes_nonroot_group_writable_source_preserving_bytes_and_exec(self):
        self.assertEqual(self.source.stat().st_uid, os.geteuid())
        self.assertTrue(self.source.stat().st_mode & 0o020)
        archive = self.archive()
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as opened:
            self.assertEqual(tuple(m.name for m in opened), self.entry.FILES)
            for member in opened:
                self.assertEqual((member.uid, member.gid), (0, 0))
                self.assertFalse(member.mode & 0o022)
                self.assertTrue(member.isreg())
                self.assertEqual(member.mode, (self.source / member.name).stat().st_mode & 0o7777 & ~0o022)
                self.assertEqual(opened.extractfile(member).read(), self.contents[member.name])
        self.entry.extract(io.BytesIO(archive), self.destination, uid=os.geteuid())
        for name in self.entry.FILES:
            self.assertEqual((self.destination / name).read_bytes(), self.contents[name])
            self.assertEqual((self.destination / name).stat().st_nlink, 1)
        # Pure verify validates all sources, not state, manager or sibling code.
        checked = bootstrap.SourceLoader(self.destination)
        checked.verify()
        self.assertEqual(checked.modules, {})
        self.assertEqual(set(bootstrap.SOURCES), {name for name in self.entry.FILES if name.endswith('.py')})

    def test_real_pipe_input_supports_complete_validation_before_extraction(self):
        driver = """import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('entry',sys.argv[1]);entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
entry.extract(sys.stdin.buffer,Path(sys.argv[2]),uid=os.geteuid())
"""
        result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', '-c', driver,
                                 str(ROOT / 'hermes-entry.py'), str(self.destination)],
                                input=self.archive(), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in self.entry.FILES:
            self.assertEqual((self.destination / name).read_bytes(), self.contents[name])

    def test_sender_refuses_missing_symlink_and_hardlink_for_every_transport_file(self):
        for name in self.entry.FILES:
            for defect in ('missing', 'symlink', 'hardlink'):
                with self.subTest(name=name, defect=defect):
                    path = self.source / name
                    data = path.read_bytes()
                    path.unlink()
                    anchor = self.root / 'anchor'
                    anchor.write_bytes(data)
                    if defect == 'symlink':
                        path.symlink_to(anchor)
                    elif defect == 'hardlink':
                        os.link(anchor, path)
                    try:
                        with self.assertRaises((OSError, ValueError)):
                            self.entry.check_files(self.source)
                    finally:
                        if path.exists() or path.is_symlink():
                            path.unlink()
                        path.write_bytes(data)
                        anchor.unlink()

    def test_typed_extraction_rejects_whole_bad_inventory_before_any_file_write(self):
        good = self.archive()
        for defect in ('missing', 'duplicate', 'symlink', 'hardlink', 'directory', 'fifo',
                       'owner', 'group', 'writable', 'path', 'extra'):
            with self.subTest(defect=defect):
                output = io.BytesIO()
                with tarfile.open(fileobj=io.BytesIO(good), mode='r:gz') as original, tarfile.open(fileobj=output, mode='w:gz') as changed:
                    members = original.getmembers()
                    if defect == 'missing':
                        members.pop()
                    if defect == 'duplicate':
                        members[-1] = copy.copy(members[0])
                    if defect == 'extra':
                        extra = copy.copy(members[0]); extra.name = 'extra'; extra.size = 0; members.append(extra)
                    for index, member in enumerate(members):
                        data = self.contents[member.name] if member.name in self.contents else b''
                        if index == 0:
                            if defect in ('symlink', 'hardlink', 'directory', 'fifo'):
                                member.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE,
                                               'directory': tarfile.DIRTYPE, 'fifo': tarfile.FIFOTYPE}[defect]
                                member.linkname = 'hermes-release.sh' if 'link' in defect else ''
                                member.size = 0
                            elif defect == 'owner': member.uid = 1000
                            elif defect == 'group': member.gid = 1000
                            elif defect == 'writable': member.mode |= 0o020
                            elif defect == 'path': member.name = '../escaped'
                        changed.addfile(member, io.BytesIO(data) if member.isreg() else None)
                with self.assertRaises((OSError, ValueError)):
                    self.entry.extract(io.BytesIO(output.getvalue()), self.destination, uid=os.geteuid())
                self.assertEqual(list(self.destination.iterdir()), [])
                self.assertFalse((self.root / 'escaped').exists())

    def test_production_extract_and_verify_reject_nonroot_entry_without_bypass(self):
        if os.geteuid() == 0:
            self.skipTest('requires unprivileged fixture owner')
        with self.assertRaises(PermissionError):
            self.entry.extract(io.BytesIO(self.archive()), self.destination)
        for key in ('TRUSTED_UID', 'HERMES_TRUSTED_UID'):
            result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', str(ROOT / 'hermes-trusted-loader.py'), 'verify'],
                                    env={key: str(os.geteuid())}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)


class ResourcePolicyTests(Fixture):
    def setUp(self):
        super().setUp()
        self.systemd = str(self.root / 'systemd')
        self.control = str(self.root / 'system.control')
        patch.object(state, 'RESOURCE_ROOTS', {**state.RESOURCE_ROOTS, self.systemd: self.control}).start()
        self.fragment = str(Path(self.systemd) / state.WORKER)
        self.memory, self.high = state.resource_paths(self.systemd)
        self.guard = str(Path(self.systemd) / (state.WORKER + '.d') / '90-aistudy-protocol-guard.conf')
        self.contents = {self.fragment: b'[Service]\nMemoryMax=1024M\nMemoryHigh=896M\n',
                         self.memory: b'[Service]\nMemoryMax=1G\n',
                         self.high: b'[Service]\nMemoryHigh=2147483648\n',
                         self.guard: b'[Unit]\nConditionPathExists=!/pause\n'}
        self.required = [str(Path(self.systemd) / (state.WORKER + '.d') / name) for name in
                         ('95-aistudy-migration-fence.conf', '96-aistudy-writer-exec.conf')]
        self.contents.update({path: b'# fixed trusted execution input\n' for path in self.required})
        self.values = {'FragmentPath': self.fragment, 'DropInPaths': ' '.join((self.memory, self.guard, self.high, *self.required)),
                       'MemoryMax': '1073741824', 'MemoryHigh': '2147483648'}
        self.effective = {state.WORKER: self.values}

    def policy(self):
        return state.resource_binding(self.systemd, self.effective, self.contents)

    def install(self):
        entries = []
        for path, data in self.contents.items():
            path = Path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o600)
            ancestors = []
            for parent in reversed(path.parents):
                st = parent.stat()
                ancestors.append({'path': str(parent), 'identity': ':'.join(str(v) for v in
                                  (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid))})
            entries.append({'path': str(path), 'identity': state.identity(path.stat()), 'ancestors': ancestors})
        self.binding['config'] = {'files': entries, 'effective': self.effective, 'resourceBinding': self.policy()}
        state.durable_write(self.root / 'protocol2-transition.json', self.binding)
        manager = type('Manager', (), {'configuration': lambda _, unit: copy.deepcopy(self.effective[unit])})
        patch.object(peer, 'SystemdManager', manager).start()

    def test_shared_resource_corpus(self):
        corpus = json.loads((Path(__file__).with_name('hermes-resource-policy-corpus.json')).read_text())
        for row in corpus:
            with self.subTest(name=row['name']):
                if 'parsed' in row:
                    self.assertEqual(state.resource_directives(row['text'].encode()), row['parsed'])
                else:
                    with self.assertRaises(ValueError):
                        state.resource_directives(row['text'].encode())

    def test_given_high_above_max_and_lexical_precedence(self):
        binding = self.policy()
        self.assertEqual(binding['units'][0]['effective'], {'MemoryMax': '1073741824', 'MemoryHigh': '2147483648'})
        # memory.conf sorts AFTER 50-MemoryHigh.conf, regardless of manager list order.
        self.contents[self.memory] = b'[Service]\nMemoryMax=1G\nMemoryHigh=768M\n'
        self.values['MemoryHigh'] = '805306368'
        self.assertEqual(self.policy()['units'][0]['effective']['MemoryHigh'], '805306368')
        self.values['DropInPaths'] = ' '.join(reversed(self.values['DropInPaths'].split()))
        self.assertEqual(self.policy()['units'][0]['effective']['MemoryHigh'], '805306368')

    def test_unknown_paths_runtime_fragment_mismatch_and_control_value_refuse(self):
        original = copy.deepcopy(self.values)
        for path in ('/other/memory.conf', self.control + '/unknown.conf',
                     '/run/systemd/system.control/' + state.WORKER + '.d/50-MemoryHigh.conf'):
            self.values['DropInPaths'] = original['DropInPaths'] + ' ' + path
            with self.assertRaises(ValueError):
                self.policy()
        self.values.update(original)
        for fragment in (self.memory, self.high):
            self.values['FragmentPath'] = fragment
            with self.assertRaises(ValueError):
                self.policy()
        self.values.update(original)
        self.values['MemoryHigh'] = '939524096'
        with self.assertRaisesRegex(ValueError, 'effective mismatch'):
            self.policy()
        self.values.update(original)
        self.contents[self.high] = b'[Service]\nMemoryHigh=1G\n'
        with self.assertRaisesRegex(ValueError, 'control MemoryHigh'):
            self.policy()
        self.assertEqual(state.resource_paths('/run/systemd/system'), {})
        self.assertEqual(state.resource_paths('/unknown/systemd'), {})
        self.assertEqual(state.resource_paths('/etc/systemd/system'), {
            '/etc/systemd/system/aistudy-worker.service.d/memory.conf': 'memory',
            '/etc/systemd/system.control/aistudy-worker.service.d/50-MemoryHigh.conf': 'control-high'})

    def test_boot_query_binds_bytes_metadata_manager_and_ancestors(self):
        self.install()
        self.commit()
        self.assertEqual(self.classify(sync=True), 'committed')
        self.values['MemoryHigh'] = '939524096'
        with self.assertRaises(ValueError):
            self.classify()
        self.values['MemoryHigh'] = '2147483648'
        path = Path(self.memory)
        replacement = path.with_suffix('.next')
        replacement.write_bytes(path.read_bytes())
        replacement.chmod(0o600)
        replacement.replace(path)
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.classify()

    def test_resource_file_dac_links_missing_and_same_inode_mutations(self):
        for defect in ('symlink', 'hardlink', 'writable', 'owner', 'missing', 'bytes', 'mode', 'ancestor'):
            with self.subTest(defect=defect):
                self.install()
                config = self.binding['config']
                path = Path(self.memory)
                if defect == 'symlink':
                    path.unlink(); path.symlink_to(self.high)
                elif defect == 'hardlink':
                    path.unlink(); os.link(self.high, path)
                elif defect == 'writable':
                    path.chmod(0o620)
                elif defect == 'missing':
                    path.unlink()
                elif defect == 'bytes':
                    path.write_bytes(b'[Service]\nMemoryMax=2G\n')
                elif defect == 'mode':
                    path.chmod(0o400)
                elif defect == 'ancestor':
                    parent = path.parent
                    parent.rename(str(parent) + '.old')
                    parent.mkdir()
                    for source in Path(str(parent) + '.old').iterdir():
                        (parent / source.name).write_bytes(source.read_bytes())
                try:
                    with patch.object(state, 'TRUSTED_UID', 12345 if defect == 'owner' else os.geteuid()):
                        with self.assertRaises((OSError, ValueError)):
                            state.validate_config(config, sync=True)
                finally:
                    for candidate in (Path(self.memory), Path(self.high), Path(self.guard)):
                        if candidate.exists() or candidate.is_symlink():
                            candidate.unlink()

    def test_resource_plan_exact_fragment_and_binding_required(self):
        self.install()
        wrapper = '/trusted/hermes-trusted-loader.py'
        values = {**self.values, 'User': 'aistudy-worker', 'Group': 'aistudy-worker',
                  'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict', 'PrivateTmp': 'yes',
                  'CapabilityBoundingSet': 'cap_setuid cap_setgid',
                  'ExecStartEx': '{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S -B '
                    + wrapper + ' exec ' + str(self.root) + ' ' + state.WORKER + ' ; flags=no-setuid ; }'}
        self.effective[state.WORKER] = values
        plan = {'unit': state.WORKER, 'systemd': self.systemd, 'state': str(self.root),
                'effective': values, 'config': self.binding['config']}
        broker = type('PlanOnly', (), {'wrapper': wrapper})()
        peer.Broker.validate_plan(broker, plan)
        for defect in ('fragment', 'unknown', 'missing', 'value', 'bytes'):
            candidate = copy.deepcopy(plan)
            if defect == 'fragment':
                candidate['effective']['FragmentPath'] = self.memory
            elif defect == 'unknown':
                candidate['effective']['DropInPaths'] += ' ' + self.control + '/unknown.conf'
            elif defect == 'missing':
                del candidate['config']['resourceBinding']
            elif defect == 'value':
                candidate['effective']['MemoryHigh'] = '939524096'
            else:
                candidate['config']['resourceBinding']['units'][0]['inputs'][0]['bytes'] = '00'
            with self.subTest(defect=defect), self.assertRaises((PermissionError, ValueError)):
                peer.Broker.validate_plan(broker, candidate)

    def test_resource_fsync_failure_and_last_fsync_drift_refuse(self):
        self.install()
        original = os.fsync
        for fault in ('file', 'ancestor', 'last-drift'):
            injected = False
            def fsync(fd):
                nonlocal injected
                path = os.readlink('/proc/self/fd/' + str(fd))
                if (fault == 'file' and path == self.high) or (fault == 'ancestor' and path == str(self.root)):
                    raise OSError('resource fsync fault')
                original(fd)
                if fault == 'last-drift' and path == str(self.root) and not injected:
                    injected = True
                    Path(self.memory).write_bytes(b'[Service]\nMemoryMax=2G\n')
            with self.subTest(fault=fault), patch.object(state.os, 'fsync', fsync):
                with self.assertRaises((OSError, ValueError)):
                    state.validate_config(self.binding['config'], sync=True)

    def test_missing_binding_and_unbound_guard_memory_refuse(self):
        self.install()
        config = self.binding['config']
        del config['resourceBinding']
        with self.assertRaisesRegex(ValueError, 'Missing resource binding'):
            state.validate_config(config)
        self.contents[self.guard] += b'[Service]\nMemoryHigh=2G\n'
        with self.assertRaisesRegex(ValueError, 'outside reviewed profile'):
            self.policy()


class RawManagerTests(unittest.TestCase):
    def setUp(self):
        self.unit = peer.UNITS[0]
        self.values = dict.fromkeys(('Id', 'ControlGroup', 'ExecStartEx', 'ExecStartPre', 'ExecStartPost',
            'ExecCondition', 'ExecReload', 'NeedDaemonReload', 'WorkingDirectory', 'User', 'Group',
            'FragmentPath', 'DropInPaths', 'EnvironmentFiles', 'NoNewPrivileges', 'CapabilityBoundingSet',
            'ProtectSystem', 'PrivateTmp', 'ProtectHome', 'ReadWritePaths', 'Restart',
            'MemoryMax', 'MemoryHigh'), '')
        self.single = '{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -S -B /controls/hermes-trusted-loader.py exec /state aistudy-web.service ; flags=no-setuid ; }'
        self.values.update(Id=self.unit, NeedDaemonReload='no', ExecStartEx=self.single)

    def properties(self, extra=''):
        raw = '\n'.join(key + '=' + value for key, value in self.values.items()) + extra
        response = type('Response', (), {'stdout': raw})()
        with patch.object(peer.subprocess, 'run', return_value=response):
            return peer.SystemdManager()._properties(self.unit)

    def test_raw_multi_path_record_duplicate_flags_and_unparseable_refused(self):
        for raw in (self.single + ' ' + self.single,
                    self.single[:-1] + 'path=/evil ; }',
                    self.single[:-1] + 'flags=privileged ; }',
                    self.single.replace('flags=no-setuid', 'flags=no-setuid ; path=/evil'),
                    self.single[:-1] + 'garbage }', ''):
            with self.subTest(raw=raw):
                self.values['ExecStartEx'] = raw
                with self.assertRaises(PermissionError):
                    self.properties()
        self.values['ExecStartEx'] = self.single
        with self.assertRaises(PermissionError):
            self.properties('\nExecStartEx=' + self.single)
        with self.assertRaises(PermissionError):
            self.properties('\nnot-a-property')
        for key in ('ExecStartPre', 'ExecStartPost', 'ExecCondition', 'ExecReload'):
            self.values[key] = '/evil'
            with self.assertRaises(PermissionError):
                self.properties()
            self.values[key] = ''

    def test_synthetic_runtime_fields_normalize_stably_without_relaxing_21_keys(self):
        expected = self.properties()
        self.values['ExecStartEx'] = self.single[:-1] + 'start_time=[Sun 2026-11-08 01:00:00 UTC] ; stop_time=[n/a] ; pid=42 ; code=(null) ; status=0 ; }'
        self.assertEqual(self.properties(), expected)
        self.values['ExecStartEx'] = self.values['ExecStartEx'].replace('status=0 ; }', 'status=0 }')
        self.assertEqual(self.properties(), expected)
        self.values['NeedDaemonReload'] = 'yes'
        with self.assertRaises(PermissionError):
            self.properties()
        self.values['NeedDaemonReload'] = 'no'
        del self.values['ExecStartPre']
        with self.assertRaises(PermissionError):
            self.properties()


class ReceiptTests(Fixture):
    def test_committed_boot_without_owner_token_and_lost_ack_query(self):
        self.commit()  # No acknowledgement consumed by caller.
        self.assertEqual(self.classify(sync=True), 'committed')
        self.assertEqual(self.classify(scope={'owner': 'b' * 32}), 'unknown')
        self.assertEqual(self.classify(scope={'transition': '/wrong'}), 'unknown')
        (self.root / 'writers-fenced').write_text('rearmed')
        self.assertEqual(self.classify(), 'fenced')

    def test_old_receipt_control_source_identity_is_not_compatible_after_reinstall(self):
        helper = self.root / 'hermes-trusted-loader.py'
        helper.write_bytes((ROOT / helper.name).read_bytes())
        self.binding['config']['files'].append({'path': str(helper), 'identity': state.identity(helper.stat())})
        state.durable_write(self.root / 'protocol2-transition.json', self.binding)
        self.commit()
        replacement = helper.with_suffix('.next')
        replacement.write_bytes(helper.read_bytes())
        os.replace(replacement, helper)
        with self.assertRaisesRegex(ValueError, 'Configuration identity changed'):
            self.classify()
        # The guard/receipt protocol is not downgraded or silently reissued.
        self.assertTrue((self.root / 'protocol2-transition.json').exists())
        self.assertTrue((self.root / 'commit-receipts' / ('a' * 32 + '.json')).exists())

    def test_succeeded_health_or_missing_receipt_never_proves_commit(self):
        for name in ('activation-incomplete', 'migration-forward-only', 'writers-fenced'):
            (self.root / name).unlink()
        (self.root / 'commit-receipts').mkdir(mode=0o700)
        (self.root / 'succeeded').write_text('healthy')
        with self.assertRaises(FileNotFoundError):
            self.classify()

    def test_production_dac_rejects_unprivileged_owned_state(self):
        if os.geteuid() == 0:
            self.skipTest('requires unprivileged fixture owner')
        with patch.object(state, 'TRUSTED_UID', 0):
            with self.assertRaises(PermissionError):
                self.classify()

    def test_broker_online_requires_grant_even_after_commit(self):
        self.commit()
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(self.broker_path))
            self.assertEqual(self.classify(), 'grant-required')

    def test_incomplete_and_residual_guards_deny_boot(self):
        self.commit()
        (self.root / 'activation-incomplete').touch()
        self.assertEqual(self.classify(), 'fenced')
        (self.root / 'activation-incomplete').unlink()
        (self.root / 'migration-forward-only').touch()
        self.assertEqual(self.classify(), 'fenced')

    def test_receipt_symlink_hardlink_modes_and_config_replacement(self):
        self.commit()
        receipt = self.root / 'commit-receipts' / ('a' * 32 + '.json')
        original = receipt.read_bytes()
        receipt.chmod(0o644)
        with self.assertRaises(PermissionError):
            self.classify()
        receipt.chmod(0o600)
        os.link(receipt, self.root / 'hardlink')
        with self.assertRaises(PermissionError):
            self.classify()
        (self.root / 'hardlink').unlink()
        receipt.unlink()
        other = self.root / 'other'
        other.write_bytes(original)
        receipt.symlink_to(other)
        with self.assertRaises(OSError):
            self.classify()
        receipt.unlink()
        receipt.write_bytes(original)
        receipt.chmod(0o600)
        self.config.unlink()
        self.config.write_text('trusted\n')
        with self.assertRaises(ValueError):
            self.classify()

    def test_guard_lstat_errors_are_not_absence(self):
        self.commit()
        original = state.os.lstat
        def fail(path, *args, **kwargs):
            if str(path).endswith('writers-fenced'):
                raise PermissionError('unreadable')
            return original(path, *args, **kwargs)
        with patch.object(state.os, 'lstat', fail):
            with self.assertRaises(PermissionError):
                self.classify()

    def test_every_fsync_rename_unlink_fault_never_claims_partial_success(self):
        # Count real syscalls first, then inject each failure independently.
        events = []
        originals = {name: getattr(state.os, name) for name in ('fsync', 'replace', 'unlink')}
        def record(name):
            def call(*args, **kwargs):
                events.append(name)
                return originals[name](*args, **kwargs)
            return call
        with patch.object(state.os, 'fsync', record('fsync')), patch.object(state.os, 'replace', record('replace')), patch.object(state.os, 'unlink', record('unlink')):
            self.commit()
        for boundary in range(len(events)):
            with self.subTest(boundary=boundary, operation=events[boundary]):
                # Fresh owner/transition, preserving real fsync/unlink semantics.
                self.setUp()
                cursor = [0]
                def fault(name):
                    def call(*args, **kwargs):
                        at = cursor[0]
                        cursor[0] += 1
                        if at == boundary:
                            raise OSError('injected persistence failure')
                        return originals[name](*args, **kwargs)
                    return call
                with patch.object(state.os, 'fsync', fault('fsync')), patch.object(state.os, 'replace', fault('replace')), patch.object(state.os, 'unlink', fault('unlink')):
                    with self.assertRaises(OSError):
                        self.commit()
                # Post-last-unlink fsync failure can be recovered ONLY by authenticated
                # durable query, never health. Otherwise at least one barrier remains.
                observed = self.classify(sync=True)
                self.assertIn(observed, ('fenced', 'committed'))
                if observed == 'committed':
                    receipt = self.root / 'commit-receipts' / ('a' * 32 + '.json')
                    self.assertEqual(json.loads(receipt.read_text())['phase'], 'terminal')

    def test_real_process_kill_at_each_persistence_boundary(self):
        # Kill immediately AFTER each real syscall. Parent queries disk state only.
        calls = []
        originals = {name: getattr(state.os, name) for name in ('fsync', 'replace', 'unlink')}
        def counted(name):
            def invoke(*args, **kwargs):
                calls.append(name)
                return originals[name](*args, **kwargs)
            return invoke
        with patch.object(state.os, 'fsync', counted('fsync')), patch.object(state.os, 'replace', counted('replace')), patch.object(state.os, 'unlink', counted('unlink')):
            self.commit()
        for boundary in range(len(calls)):
            with self.subTest(boundary=boundary):
                self.setUp()
                child = os.fork()
                if child == 0:
                    counter = [0]
                    for name in ('fsync', 'replace', 'unlink'):
                        original = getattr(state.os, name)
                        def hooked(*args, _original=original, **kwargs):
                            result = _original(*args, **kwargs)
                            at = counter[0]
                            counter[0] += 1
                            if at == boundary:
                                os.kill(os.getpid(), signal.SIGKILL)
                            return result
                        setattr(state.os, name, hooked)
                    self.commit()
                    os._exit(0)
                os.waitpid(child, 0)
                self.assertIn(self.classify(sync=True), ('fenced', 'committed'))


class WrapperTests(Fixture):
    def setUp(self):
        super().setUp()
        self.wrapper = load('hermes-writer-exec')
        self.plan = {**self.binding, 'unit': peer.UNITS[0], 'state': str(self.root), 'current': str(self.current),
                     'effective': {'NeedDaemonReload': 'no'}, 'user': '', 'group': ''}
        state.durable_write(self.root / ('writer-' + peer.UNITS[0] + '.json'), self.plan)
        # Explicit object injection only, preserving real proc/dirfd/socket IO.
        patch.object(peer, 'state_api', state).start()

    def test_fenced_boot_and_incomplete_deny_before_manager_or_exec(self):
        with self.assertRaises(PermissionError):
            self.wrapper.admit(peer, str(self.root), peer.UNITS[0], str(self.broker_path))
        self.commit()
        (self.root / 'activation-incomplete').touch()
        with self.assertRaises(PermissionError):
            self.wrapper.admit(peer, str(self.root), peer.UNITS[0], str(self.broker_path))

    def test_missing_protocol_marker_never_downgrades_plan_to_legacy(self):
        self.commit()
        (self.root / 'protocol2-transition.json').unlink()
        self.assertEqual(self.classify(), 'legacy')
        with self.assertRaises(PermissionError):
            self.wrapper.admit(peer, str(self.root), peer.UNITS[0], str(self.broker_path))

    def test_disabled_worker_cannot_boot_even_with_terminal_receipt(self):
        plan = {**self.plan, 'unit': peer.UNITS[1], 'required': '0'}
        state.durable_write(self.root / ('writer-' + peer.UNITS[1] + '.json'), plan)
        self.commit()
        with self.assertRaisesRegex(PermissionError, 'Worker disabled'):
            self.wrapper.admit(peer, str(self.root), peer.UNITS[1], str(self.broker_path))

    def test_committed_boot_pins_target_fd_and_template(self):
        self.commit()
        group = peer.proc_identity(os.getpid())['cgroup'].strip().split('::')[1]
        fake = type('Adapter', (), {'snapshot': lambda _, pid, unit: {'NeedDaemonReload': 'no', 'ControlGroup': group}})
        with patch.object(peer, 'SystemdManager', fake):
            plan, fd = self.wrapper.admit(peer, str(self.root), peer.UNITS[0], str(self.broker_path))
        try:
            self.assertEqual(os.fstat(fd).st_ino, self.target.stat().st_ino)
        finally:
            os.close(fd)
        self.assertEqual(self.wrapper.application(plan['target'], peer.UNITS[0]), ['/usr/bin/node', str(self.target) + '/apps/web/.next/standalone/apps/web/server.js'])
        with self.assertRaises(PermissionError):
            self.wrapper.application(str(self.target), 'untrusted.service')

    def test_production_manager_unavailable_never_falls_back(self):
        self.commit()
        with patch.object(peer.subprocess, 'run', side_effect=FileNotFoundError('systemd unavailable')):
            with self.assertRaises(FileNotFoundError):
                self.wrapper.admit(peer, str(self.root), peer.UNITS[0], str(self.broker_path))

    def test_real_same_pid_exec_preserves_starttime_and_directory(self):
        child = os.fork()
        if child == 0:
            # Real exec with harmless Python target in place of Node. Production
            # application templates remain fixed; only this test module is patched.
            plan = self.plan
            self.wrapper.application = lambda target, unit: ['/usr/bin/python3', '-I', '-S', '-c',
                'import os,pathlib;pathlib.Path("exec-proof").write_text(str(os.getpid())+"\\n"+pathlib.Path("/proc/self/stat").read_text().split(") ")[1].split()[19])']
            self.wrapper.os.execve = lambda exe, argv, env: os.execv('/usr/bin/python3', argv)
            fd = os.open(self.target, os.O_RDONLY | os.O_DIRECTORY)
            self.wrapper.execute(plan, fd)
            os._exit(1)
        started = peer.proc_identity(child)['start']
        _, result = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(result), 0)
        proof = (self.target / 'exec-proof').read_text().splitlines()
        self.assertEqual(proof, [str(child), started])

    def test_same_pid_fchdir_and_exact_exec_scrubs_control_environment(self):
        fd = os.open(self.target, os.O_RDONLY | os.O_DIRECTORY)
        pid = os.getpid()
        previous = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
        captured = []
        def execute(exe, argv, env):
            captured.append((os.getpid(), os.stat('.').st_ino, exe, argv, env))
        try:
            with patch.object(self.wrapper.os, 'execve', execute), patch.dict(os.environ, {'HERMES_SUPERVISOR_TOKEN': 'private', 'NODE_OPTIONS': '--require=bad', 'DATABASE_URL': 'needed'}):
                self.wrapper.execute(self.plan, fd)
        finally:
            os.fchdir(previous)
            os.close(previous)
        self.assertEqual(captured[0][:3], (pid, self.target.stat().st_ino, '/usr/bin/node'))
        self.assertNotIn('HERMES_SUPERVISOR_TOKEN', captured[0][4])
        self.assertNotIn('NODE_OPTIONS', captured[0][4])
        self.assertEqual(captured[0][4]['DATABASE_URL'], 'needed')

    def test_worker_initgroups_then_gid_uid_before_exec(self):
        fd = os.open(self.target, os.O_RDONLY | os.O_DIRECTORY)
        previous = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
        plan = {**self.plan, 'unit': peer.UNITS[1], 'user': 'aistudy-worker', 'group': 'aistudy-worker'}
        events = []
        account = type('Account', (), {'pw_name': 'aistudy-worker', 'pw_uid': 1234, 'pw_gid': 1235})
        try:
            with patch.object(self.wrapper.pwd, 'getpwnam', return_value=account), patch.object(self.wrapper.os, 'initgroups', lambda *args: events.append(('groups', args))), patch.object(self.wrapper.os, 'setgid', lambda gid: events.append(('gid', gid))), patch.object(self.wrapper.os, 'setuid', lambda uid: events.append(('uid', uid))), patch.object(self.wrapper.os, 'execve', lambda *args: events.append(('exec', args[1]))):
                self.wrapper.execute(plan, fd)
        finally:
            os.fchdir(previous)
            os.close(previous)
        self.assertEqual([e[0] for e in events], ['groups', 'gid', 'uid', 'exec'])
        self.assertEqual(events[-1][1][-1], str(self.target) + '/apps/worker/src/index.ts')


class FakeManager:
    def __init__(self):
        self.value = {'ControlGroup': Path('/proc/self/cgroup').read_text().strip().split('::')[1], 'NeedDaemonReload': 'no'}
        self.calls = 0
        self.mutate = False
    def snapshot(self, pid, unit):
        self.calls += 1
        if unit != peer.UNITS[0]:
            raise PermissionError('wrong unit')
        value = dict(self.value)
        if self.mutate and self.calls > 1:
            value['NeedDaemonReload'] = 'yes'
        return value


class KernelBrokerTests(Fixture):
    def setUp(self):
        super().setUp()
        self.wrapper = self.root / 'wrapper.py'
        self.wrapper.write_text('import socket,sys\ns=socket.socket(socket.AF_UNIX);s.connect(sys.argv[2]+"/exec.sock");print(s.recv(65536).decode(),flush=True)\n')
        self.manager = FakeManager()
        self.broker = peer.Broker(self.manager, os.getpid(), peer.proc_identity(os.getpid())['start'],
                                  str(self.wrapper), '/usr/bin/python3', str(self.current), (os.geteuid(), os.getegid()))
        self.addCleanup(os.close, self.broker.owner_fd)
        expected = f'/usr/bin/python3 -I -S -B {self.wrapper} exec {self.root} {peer.UNITS[0]}'
        self.manager.value.update({'ExecStartEx': '{ path=/usr/bin/python3 ; argv[]=' + expected + ' ; flags= ; }',
                                   'FragmentPath': str(self.root / peer.UNITS[0]), 'DropInPaths': '', 'User': '', 'Group': ''})
        self.plan = {**self.binding, 'unit': peer.UNITS[0], 'state': str(self.root), 'systemd': str(self.root),
                     'effective': {key: value for key, value in self.manager.value.items() if key != 'ControlGroup'}}
        self.broker.prepare(self.plan)
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(self.broker_path))
        self.listener.listen(8)
        self.listener.settimeout(5)
        self.addCleanup(self.listener.close)

    def attempt(self, script=None, unit=None, before=None):
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-B', str(script or self.wrapper), 'exec', str(self.root), unit or peer.UNITS[0]], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        conn, _ = self.listener.accept()
        conn.settimeout(5)  # Match production accepted sockets, not blocking-only test sockets.
        with conn:
            credentials = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            self.assertEqual(credentials[0], child.pid)
            fd = os.pidfd_open(credentials[0])
            try:
                if before:
                    before(child, conn)
                try:
                    result = self.broker.allow(credentials, fd, conn)
                    response = {'ok': True, 'pid': result['peerPid'], 'start': result['peerStart']}
                except Exception:
                    response = {'ok': False}
                try:
                    conn.sendall(json.dumps(response).encode() + b'\n')
                except BrokenPipeError:
                    pass
            finally:
                os.close(fd)
        output, error = child.communicate(timeout=5)
        return response, output, error

    def test_production_credentials_reject_unprivileged_peer(self):
        if os.geteuid() == 0:
            self.skipTest('requires non-root peer')
        self.broker.credentials = (0, 0)
        self.assertFalse(self.attempt()[0]['ok'])

    def test_actual_peer_pid_once_consume_and_autorestart_denial(self):
        first, _, _ = self.attempt()
        self.assertTrue(first['ok'])
        second, _, _ = self.attempt()
        self.assertFalse(second['ok'])
        with self.assertRaises(PermissionError):
            self.broker.prepare(self.plan)

    def test_wrong_wrapper_wrong_unit_and_config_toctou_deny_without_consume(self):
        other = self.root / 'other.py'
        other.write_text(self.wrapper.read_text())
        self.assertFalse(self.attempt(script=other)[0]['ok'])
        self.assertFalse(self.attempt(unit=peer.UNITS[1])[0]['ok'])
        self.manager.mutate = True
        self.assertFalse(self.attempt()[0]['ok'])
        self.assertIn(peer.UNITS[0], self.broker.grants)

    def test_current_replacement_and_owner_revocation(self):
        self.current.unlink()
        other = self.root / 'other-target'
        other.mkdir()
        self.current.symlink_to(other)
        self.assertFalse(self.attempt()[0]['ok'])
        self.broker.revoke()
        self.assertFalse(self.attempt()[0]['ok'])

    def test_peer_exit_pidfd_and_disconnect_deny(self):
        def die(child, conn):
            child.kill()
            child.wait(timeout=5)
        self.assertFalse(self.attempt(before=die)[0]['ok'])

    def test_reaped_queued_peer_cannot_terminate_serve_or_consume_generation(self):
        self.listener.close()
        self.broker_path.unlink()
        reader, writer = os.pipe()
        parent_barrier, server_barrier = multiprocessing.Pipe()
        original_select = peer.selectors.DefaultSelector.select
        original_open = os.pidfd_open

        def run():
            os.close(writer)
            parent_barrier.close()
            first = True
            def select(selector, *args, **kwargs):
                nonlocal first
                if first:
                    first = False
                    server_barrier.send('listening-before-accept')
                    if server_barrier.recv() != 'peer-reaped':
                        raise AssertionError('Missing reap barrier')
                return original_select(selector, *args, **kwargs)
            def pin(pid, *args, **kwargs):
                try:
                    return original_open(pid, *args, **kwargs)
                except ProcessLookupError:
                    server_barrier.send(('reaped-before-pin', pid, self.manager.calls,
                                         peer.UNITS[0] in self.broker.grants, dict(self.broker.used)))
                    raise
            with os.fdopen(reader, 'rb') as source, server_barrier:
                with patch.object(peer.selectors.DefaultSelector, 'select', select), patch.object(peer.os, 'pidfd_open', pin):
                    peer.serve(self.root, self.broker, source)

        process = multiprocessing.get_context('fork').Process(target=run)
        process.start()
        os.close(reader)
        server_barrier.close()
        try:
            self.assertTrue(parent_barrier.poll(5), 'server never reached pre-accept barrier')
            self.assertEqual(parent_barrier.recv(), 'listening-before-accept')
            child = os.fork()
            if child == 0:
                try:
                    with socket.socket(socket.AF_UNIX) as client:
                        client.connect(str(self.broker_path))
                    os._exit(0)
                except BaseException:
                    os._exit(1)
            _, status = os.waitpid(child, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, 'peer did not connect and exit')
            # No accept or peer pidfd_open is possible until waitpid has reaped
            # the connected child; no sleep/race or pre-opened pidfd substitute.
            parent_barrier.send('peer-reaped')
            self.assertTrue(parent_barrier.poll(5), 'queued peer never reached real pidfd_open')
            self.assertEqual(parent_barrier.recv(), ('reaped-before-pin', child, 0, True, {}))
            command = ['/usr/bin/python3', '-I', '-S', '-B', str(self.wrapper), 'exec', str(self.root), peer.UNITS[0]]
            allowed = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
            reply = json.loads(allowed.stdout)
            self.assertTrue(reply['ok'], allowed.stdout + allowed.stderr)
            self.assertEqual(reply['plan']['owner'], self.plan['owner'])
            self.assertEqual(reply['plan']['transition'], self.plan['transition'])
            replay = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual(json.loads(replay.stdout), {'ok': False})
            os.close(writer)
            writer = None
            process.join(5)
            self.assertEqual(process.exitcode, 0)
            self.assertFalse(self.broker_path.exists())
            self.assertFalse((self.root / 'control.sock').exists())
        finally:
            if writer is not None:
                os.close(writer)
            parent_barrier.close()
            if process.is_alive():
                process.terminate()
            process.join(5)
            process.close()

    def test_parallel_helpers_only_one_allow(self):
        # Two actual processes are accepted against a single owner generation.
        children = [subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-B', str(self.wrapper), 'exec', str(self.root), peer.UNITS[0]], stdout=subprocess.PIPE) for _ in range(2)]
        connections = [self.listener.accept()[0] for _ in children]
        outcomes = []
        def handle(conn):
            with conn:
                creds = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                fd = os.pidfd_open(creds[0])
                try:
                    try:
                        self.broker.allow(creds, fd, conn)
                        outcomes.append(True)
                    except Exception:
                        outcomes.append(False)
                    conn.sendall(b'{}\n')
                finally:
                    os.close(fd)
        threads = [threading.Thread(target=handle, args=(conn,)) for conn in connections]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        for child in children:
            child.communicate(timeout=5)
        self.assertEqual(sorted(outcomes), [False, True])

    def test_unreaped_owner_cannot_authorize_control(self):
        owner = subprocess.Popen(['/usr/bin/python3', '-c', 'import time;time.sleep(30)'])
        broker = peer.Broker(self.manager, owner.pid, peer.proc_identity(owner.pid)['start'], str(self.wrapper), '/usr/bin/python3', str(self.current))
        try:
            owner.kill()
            # waitid WNOWAIT observes exit without reaping the real zombie PID.
            os.waitid(os.P_PID, owner.pid, os.WEXITED | os.WNOWAIT)
            with self.assertRaises((ProcessLookupError, PermissionError)):
                broker.owner_alive()
        finally:
            owner.wait(timeout=5)
            os.close(broker.owner_fd)

    def test_owner_dead_cannot_prepare_or_allow(self):
        owner = subprocess.Popen(['/usr/bin/python3', '-c', 'import time;time.sleep(30)'])
        broker = peer.Broker(self.manager, owner.pid, peer.proc_identity(owner.pid)['start'], str(self.wrapper), '/usr/bin/python3', str(self.current))
        try:
            owner.kill()
            owner.wait(timeout=5)
            with self.assertRaises((ProcessLookupError, PermissionError)):
                broker.prepare(self.plan)
        finally:
            os.close(broker.owner_fd)

    def test_pipe_eof_revokes_and_unlinks_actual_sockets(self):
        self.listener.close()
        self.broker_path.unlink()
        reader, writer = os.pipe()
        def run():
            os.close(writer)
            with os.fdopen(reader, 'rb') as source:
                peer.serve(self.root, self.broker, source)
        process = multiprocessing.get_context('fork').Process(target=run)
        process.start()
        os.close(reader)
        # Control request waits for sockets through bounded connection attempts in test only.
        import time
        deadline = time.monotonic() + 5
        while not (self.root / 'control.sock').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue((self.root / 'control.sock').exists())
        os.close(writer)
        process.join(5)
        self.assertEqual(process.exitcode, 0)
        self.assertFalse(self.broker_path.exists())
        self.assertFalse((self.root / 'control.sock').exists())


if __name__ == '__main__':
    if sys.argv[1:] == ['resource-policy-fixture']:
        payload = json.load(sys.stdin)
        # Explicit test-object injection; production CLI has no profile/UID switch.
        state.RESOURCE_ROOTS = {payload['systemd']: str(Path(payload['systemd']).parent / 'system.control')}
        print(json.dumps(state.resource_binding(payload['systemd'], payload['effective'],
              {row['path']: bytes.fromhex(row['bytes']) for row in payload['files']})))
    else:
        unittest.main()
