"""Local kernel/process/filesystem tests; no systemd, DB, VM or paid API."""
import copy
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / 'infra/deploy'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state = load('hermes-writer-state')
peer = load('hermes-peer-broker')


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
        for name in ('migration-forward-only', 'writers-fenced'):
            (self.root / name).write_text('fenced')
        self.addCleanup(self.temporary.cleanup)

    def classify(self, **kwargs):
        return state.classify(self.root, self.current, self.broker_path, **kwargs)

    def commit(self):
        state.commit(self.root, self.current, self.broker_path, self.binding)


class ReceiptTests(Fixture):
    def test_committed_boot_without_owner_token_and_lost_ack_query(self):
        self.commit()  # No acknowledgement consumed by caller.
        self.assertEqual(self.classify(sync=True), 'committed')
        self.assertEqual(self.classify(scope={'owner': 'b' * 32}), 'unknown')
        self.assertEqual(self.classify(scope={'transition': '/wrong'}), 'unknown')
        (self.root / 'writers-fenced').write_text('rearmed')
        self.assertEqual(self.classify(), 'fenced')

    def test_succeeded_health_or_missing_receipt_never_proves_commit(self):
        for name in ('migration-forward-only', 'writers-fenced'):
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


@unittest.skipUnless(hasattr(os, 'pidfd_open'), 'Linux peercred/pidfd required')
class KernelBrokerTests(Fixture):
    def setUp(self):
        super().setUp()
        self.wrapper = self.root / 'wrapper.py'
        self.wrapper.write_text('import socket,sys\ns=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]+"/exec.sock");print(s.recv(65536).decode(),flush=True)\n')
        self.manager = FakeManager()
        self.broker = peer.Broker(self.manager, os.getpid(), peer.proc_identity(os.getpid())['start'],
                                  str(self.wrapper), '/usr/bin/python3', str(self.current), (os.geteuid(), os.getegid()))
        self.addCleanup(os.close, self.broker.owner_fd)
        expected = f'/usr/bin/python3 -I -S {self.wrapper} {self.root} {peer.UNITS[0]}'
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
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-S', str(script or self.wrapper), str(self.root), unit or peer.UNITS[0]], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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

    def test_parallel_helpers_only_one_allow(self):
        # Two actual processes are accepted against a single owner generation.
        children = [subprocess.Popen(['/usr/bin/python3', '-I', '-S', str(self.wrapper), str(self.root), peer.UNITS[0]], stdout=subprocess.PIPE) for _ in range(2)]
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
    unittest.main()
