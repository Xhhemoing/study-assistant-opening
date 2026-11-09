#!/usr/bin/python3
"""Root-local, per-execution admission. JSON never supplies peer PID/UID/GID.

The production adapter is mandatory in the CLI. Tests inject adapters through
Python objects only; there is no environment variable or CLI fake-manager mode.
"""
import ctypes
import errno
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import struct
import subprocess
import sys
import threading


def load_state():
    spec = importlib.util.spec_from_file_location('writer_state', Path(__file__).with_name('hermes-writer-state.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state_api = load_state()
UNITS = ('aistudy-web.service', 'aistudy-worker.service')


def proc_identity(pid):
    root = Path('/proc') / str(pid)
    raw = (root / 'stat').read_text()
    started = raw[raw.rfind(')') + 2:].split()[19]
    return {'start': started, 'exe': os.path.realpath(root / 'exe'),
            'argv': (root / 'cmdline').read_bytes().split(b'\0')[:-1],
            'cgroup': (root / 'cgroup').read_text()}


def connected(sock):
    return sock.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) != b''


def still_connected(sock):
    timeout = sock.gettimeout()
    try:
        sock.setblocking(False)
        return connected(sock)
    except BlockingIOError:
        return True
    finally:
        sock.settimeout(timeout)


class SystemdManager:
    def snapshot(self, pid, unit):
        result = subprocess.run(['/usr/bin/busctl', '--system', '--json=short', 'call',
                                 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                                 'org.freedesktop.systemd1.Manager', 'GetUnitByPID', 'u', str(pid)],
                                check=True, capture_output=True, text=True, timeout=5)
        object_path = json.loads(result.stdout)['data'][0]
        expected = '/org/freedesktop/systemd1/unit/' + unit.replace('-', '_2d').replace('.', '_2e')
        if object_path != expected:
            raise PermissionError('Manager unit mismatch')
        return self._properties(unit)

    def configuration(self, unit):
        values = self._properties(unit)
        del values['ControlGroup']
        return values

    def _properties(self, unit):
        if unit not in UNITS:
            raise PermissionError('Unknown unit')
        keys = ('Id', 'ControlGroup', 'ExecStartEx', 'ExecStartPre', 'ExecStartPost',
                'ExecCondition', 'ExecReload', 'NeedDaemonReload', 'WorkingDirectory', 'User', 'Group',
                'FragmentPath', 'DropInPaths', 'EnvironmentFiles', 'NoNewPrivileges', 'CapabilityBoundingSet',
                'ProtectSystem', 'PrivateTmp', 'ProtectHome', 'ReadWritePaths', 'Restart')
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--property=' + ','.join(keys)],
                                check=True, capture_output=True, text=True, timeout=5)
        values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        # ExecStartEx includes runtime timestamps/PIDs/status after launch. Pin only
        # executable/argv/flags, recapturing those at grant and before receipt.
        import re
        launch = re.fullmatch(r'\{ path=([^;]+) ; argv\[\]=(.*?) ; flags=([^;]*?) ;.*\}', values.get('ExecStartEx', ''))
        if not launch:
            raise PermissionError('Cannot parse sole ExecStartEx')
        values['ExecStartEx'] = '{ path=' + launch[1].strip() + ' ; argv[]=' + launch[2] + ' ; flags=' + launch[3].strip() + ' ; }'
        if set(values) != set(keys) or values['Id'] != unit or values['NeedDaemonReload'] != 'no':
            raise PermissionError('Incomplete or stale manager configuration')
        if any(values[key] for key in ('ExecStartPre', 'ExecStartPost', 'ExecCondition', 'ExecReload')):
            raise PermissionError('Unreviewed executable hook')
        return values


class Broker:
    def __init__(self, manager, owner_pid, owner_start, wrapper, python, current, credentials=(0, 0)):
        self.manager = manager
        self.credentials = credentials
        self.owner_pid, self.owner_start = owner_pid, owner_start
        self.wrapper, self.python, self.current = wrapper, python, current
        self.grants = {}
        self.used = {}
        self.lock = threading.Lock()
        self.owner_fd = os.pidfd_open(owner_pid)

    def owner_alive(self):
        signal.pidfd_send_signal(self.owner_fd, 0)
        raw = (Path('/proc') / str(self.owner_pid) / 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        if fields[0] in ('Z', 'X') or fields[19] != self.owner_start:
            raise PermissionError('Owner changed or exited')

    def revoke(self):
        with self.lock:
            self.grants.clear()

    def validate_plan(self, plan):
        values = plan['effective']
        expected = f'/usr/bin/python3 -I -S {self.wrapper} {plan["state"]} {plan["unit"]}'
        launch = values['ExecStartEx']
        if launch.count('path=') != 1 or 'path=/usr/bin/python3 ;' not in launch or f'argv[]={expected} ;' not in launch:
            raise PermissionError('Not sole trusted ExecStart')
        allowed = {str(Path(plan['systemd']) / plan['unit']),
                   str(Path(plan['systemd']) / (plan['unit'] + '.d') / '50-aistudy-release.conf'),
                   str(Path(plan['systemd']) / (plan['unit'] + '.d') / '90-aistudy-protocol-guard.conf'),
                   str(Path(plan['systemd']) / (plan['unit'] + '.d') / '95-aistudy-migration-fence.conf'),
                   str(Path(plan['systemd']) / (plan['unit'] + '.d') / '96-aistudy-writer-exec.conf')}
        if values['FragmentPath'] not in allowed or any(path not in allowed for path in values['DropInPaths'].split()):
            raise PermissionError('Unknown effective unit input')
        if plan['unit'] == UNITS[1]:
            if (values['User'], values['Group'], values['NoNewPrivileges'], values['ProtectSystem'], values['PrivateTmp']) != ('aistudy-worker', 'aistudy-worker', 'yes', 'strict', 'yes'):
                raise PermissionError('Worker sandbox mismatch')
            if set(values['CapabilityBoundingSet'].lower().split()) != {'cap_setuid', 'cap_setgid'} or 'no-setuid' not in launch or 'privileged' in launch:
                raise PermissionError('Worker credential-only prefix/capabilities mismatch')
        elif values['User'] or values['Group']:
            raise PermissionError('Unreviewed web credentials')

    def prepare(self, plan):
        with self.lock:
            self.owner_alive()
            if plan['unit'] in self.grants or plan['unit'] in self.used:
                raise PermissionError('Owner generation already prepared')
            if plan['unit'] not in UNITS or os.path.realpath(self.current) != plan['target']:
                raise PermissionError('Invalid grant target/unit')
            self.validate_plan(plan)
            state_api.validate_config(plan['config'], sync=True)
            self.grants[plan['unit']] = plan

    def allow(self, peer, pidfd, sock):
        pid, uid, gid = peer
        with self.lock:
            self.owner_alive()
            if (uid, gid) != self.credentials:
                raise PermissionError('Helper must arrive with root credentials')
            before = proc_identity(pid)
            # Exact interpreter/script/arguments. Never accept peer claims.
            prefix = [os.fsencode(self.python), b'-I', b'-S', os.fsencode(self.wrapper)]
            if before['exe'] != os.path.realpath(self.python) or before['argv'][:4] != prefix or len(before['argv']) != 6:
                raise PermissionError('Not the trusted wrapper')
            unit = os.fsdecode(before['argv'][5])
            plan = self.grants.get(unit)
            if not plan or before['argv'][4] != os.fsencode(plan['state']):
                raise PermissionError('No generation for this helper')
            observed = self.manager.snapshot(pid, unit)
            group = observed['ControlGroup']
            configuration = {key: value for key, value in observed.items() if key != 'ControlGroup'}
            if not group or f'0::{group}\n' != before['cgroup'] or configuration != plan['effective']:
                raise PermissionError('Unit/cgroup/config mismatch')
            if os.path.realpath(self.current) != plan['target']:
                raise PermissionError('CURRENT changed')
            target_fd = os.open(plan['target'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                st = os.fstat(target_fd)
                if [st.st_dev, st.st_ino] != plan['targetIdentity']:
                    raise PermissionError('Target directory replaced')
            finally:
                os.close(target_fd)
            state_api.validate_config(plan['config'])
            # Adjacent recapture after config/proc IO. pidfd prevents PID reuse.
            self.owner_alive()
            if proc_identity(pid) != before or self.manager.snapshot(pid, unit) != observed:
                raise PermissionError('Peer or manager changed')
            signal.pidfd_send_signal(pidfd, 0)
            if not still_connected(sock):
                raise PermissionError('Peer disconnected')
            del self.grants[unit]  # Consume BEFORE ALLOW; a failed send does not refund.
            self.used[unit] = {'pid': pid, 'start': before['start']}
            return {**plan, 'peerPid': pid, 'peerStart': before['start']}


def receive(sock):
    body = bytearray()
    while b'\n' not in body:
        part = sock.recv(65536)
        if not part or len(body) + len(part) > 1024 * 1024:
            raise ValueError('Invalid broker message')
        body.extend(part)
    return json.loads(body.split(b'\n', 1)[0])


def control(path, payload):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(10)
        sock.connect(path)
        sock.sendall(json.dumps(payload).encode() + b'\n')
        response = receive(sock)
        if not response.get('ok'):
            raise PermissionError('Broker control refused')
        return response


def serve(directory, broker, stdin):
    sockets = []
    bound_paths = set()
    selector = selectors.DefaultSelector()
    try:
        for name in ('exec.sock', 'control.sock'):
            sock = socket.socket(socket.AF_UNIX)
            sock.bind(str(Path(directory) / name))
            bound_paths.add(name)
            os.chmod(Path(directory) / name, 0o600)
            sock.listen(8)
            selector.register(sock, selectors.EVENT_READ, name)
            sockets.append(sock)
        selector.register(stdin, selectors.EVENT_READ, 'owner-pipe')
        selector.register(broker.owner_fd, selectors.EVENT_READ, 'owner-dead')
        print('READY', flush=True)
        while True:
            ready = selector.select()
            # EOF/death wins over every queued control/admission event in the
            # same readiness batch, irrespective of selector ordering.
            if any(key.data in ('owner-pipe', 'owner-dead') for key, _ in ready):
                broker.revoke()
                return
            for key, _ in ready:
                conn, _ = key.fileobj.accept()
                with conn:
                    try:
                        conn.settimeout(5)
                        peer = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        # Pin before parsing untrusted bytes; a queued peer may
                        # already be reaped, which rejects only this connection.
                        peer_fd = os.pidfd_open(peer[0])
                    except OSError as error:
                        if error.errno in (errno.ESRCH, errno.EPERM, errno.EACCES,
                                           errno.ECONNRESET, errno.ENOTCONN, errno.EPIPE):
                            continue  # with closes the rejected peer; no grant consumed.
                        raise  # Resource/kernel/server failures remain visible.
                    try:
                        if key.data == 'exec.sock':
                            # No JSON claims at all from the execution peer.
                            reply = {'ok': True, 'plan': broker.allow(peer, peer_fd, conn)}
                        else:
                            if peer[1:] != (0, 0):
                                raise PermissionError('Not root control')
                            message = receive(conn)
                            broker.owner_alive()
                            if message['action'] == 'prepare':
                                broker.prepare(message['plan'])
                            elif message['action'] == 'configuration':
                                reply = {'ok': True, 'effective': broker.manager.configuration(message['unit'])}
                                conn.sendall(json.dumps(reply).encode() + b'\n')
                                continue
                            elif message['action'] == 'status':
                                conn.sendall(json.dumps({'ok': True, 'executions': broker.used}).encode() + b'\n')
                                continue
                            elif message['action'] == 'revoke':
                                broker.revoke()
                            elif message['action'] == 'close':
                                broker.revoke()
                                # Close/unlink before ACK: no boot admission while grants remain.
                                for listener in sockets:
                                    listener.close()
                                for name in ('exec.sock', 'control.sock'):
                                    os.unlink(Path(directory) / name)
                                    bound_paths.remove(name)
                                conn.sendall(b'{"ok":true}\n')
                                return
                            else:
                                raise ValueError('Unknown control action')
                            reply = {'ok': True}
                        conn.sendall(json.dumps(reply).encode() + b'\n')
                    except Exception:
                        try:
                            conn.sendall(b'{"ok":false}\n')
                        except OSError:
                            pass
                    finally:
                        os.close(peer_fd)
    finally:
        broker.revoke()
        selector.close()
        for sock in sockets:
            sock.close()
        # After close ACK the parent may retire the directory. Never let this
        # old child exit handler unlink sockets belonging to a later generation.
        for name in bound_paths:
            path = Path(directory) / name
            if os.path.lexists(path):
                os.unlink(path)


def main():
    if sys.argv[1] == 'control':
        print(json.dumps(control(sys.argv[2], json.load(sys.stdin))))
        return
    _, _, directory, current, wrapper, owner_pid, owner_start = sys.argv
    # Parent death kills admission, even if another root child inherited stdin.
    parent = os.getppid()
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM) != 0 or os.getppid() != parent:
        raise PermissionError('Cannot bind broker lifetime')
    fd = state_api.safe_open(directory, private=True, directory=True)
    os.close(fd)
    broker = Broker(SystemdManager(), int(owner_pid), owner_start, wrapper, '/usr/bin/python3', current)
    serve(directory, broker, sys.stdin.buffer)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Broker unavailable; execution denied', file=sys.stderr)
        sys.exit(1)
