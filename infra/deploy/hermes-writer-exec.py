#!/usr/bin/python3
"""Sole systemd ExecStart, invoked via the fixed Python -I -S -B loader, never candidate imports.

This gates manager jobs, not hostile host root/release code. No fork before
admission: SO_PEERCRED PID/starttime remains the final application's identity.
"""
import json
import os
from pathlib import Path
import pwd
import socket
import sys

BROKER = '/run/aistudy-writer-broker/exec.sock'


def controls():
    return trusted_loader.load('hermes-peer-broker.py')


def application(target, unit):
    if unit == 'aistudy-web.service':
        return ['/usr/bin/node', target + '/apps/web/.next/standalone/apps/web/server.js']
    if unit == 'aistudy-worker.service':
        return ['/usr/bin/node', target + '/node_modules/tsx/dist/cli.mjs', target + '/apps/worker/src/index.ts']
    raise PermissionError('Unknown writer')


def load_plan(api, state, unit):
    return json.loads(api.read_trusted(Path(state) / ('writer-' + unit + '.json'), private=True)[0])


def admit(peer, state, unit, broker=BROKER):
    api = peer.state_api
    plan = load_plan(api, state, unit)
    if unit == 'aistudy-worker.service' and plan.get('required') == '0':
        raise PermissionError('Worker disabled for this transition')
    status = api.classify(state, plan['current'], broker, sync=True)
    if status == 'grant-required':
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(10)
            conn.connect(broker)
            response = peer.receive(conn)  # No claimed PID/UID or bearer token sent.
            if not response.get('ok'):
                raise PermissionError('No owner grant')
            allowed = response['plan']
            if any(allowed[key] != plan[key] for key in ('unit', 'state', 'target', 'targetIdentity', 'config', 'effective', 'current', 'user', 'group')):
                raise PermissionError('Grant snapshot mismatch')
            if allowed['peerPid'] != os.getpid() or allowed['peerStart'] != peer.proc_identity(os.getpid())['start']:
                raise PermissionError('Grant process mismatch')
    elif status != 'committed':
        # A protocol-2 plan never downgrades to legacy admission when a marker
        # is missing. Historical recovery requires the separate approved profile.
        raise PermissionError('Writer fenced or commit unknown')
    # Broker could have disappeared or appeared while reading classifier state.
    # Adjacent classify must agree; no fallback from failed online authorization.
    if status != 'grant-required' and api.present(broker):
        raise PermissionError('Owner appeared; require managed authorization')
    if plan['unit'] != unit or plan['state'] != state or os.path.realpath(plan['current']) != plan['target']:
        raise PermissionError('Pinned target changed')
    pid = os.getpid()
    identity = peer.proc_identity(pid)
    effective = peer.SystemdManager().snapshot(pid, unit)
    configuration = {key: value for key, value in effective.items() if key != 'ControlGroup'}
    if configuration != plan['effective'] or identity['cgroup'] != '0::' + effective['ControlGroup'] + '\n':
        raise PermissionError('Manager configuration changed')
    api.validate_config(plan['config'])
    target_fd = os.open(plan['target'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    st = os.fstat(target_fd)
    if [st.st_dev, st.st_ino] != plan['targetIdentity']:
        os.close(target_fd)
        raise PermissionError('Pinned target directory changed')
    return plan, target_fd


def execute(plan, target_fd):
    unit, target = plan['unit'], plan['target']
    argv = application(target, unit)
    # Keep the exact directory inode through chdir; CURRENT is never argv authority.
    os.fchdir(target_fd)
    os.close(target_fd)
    if unit == 'aistudy-worker.service':
        account = pwd.getpwnam('aistudy-worker')
        if account.pw_uid == 0 or account.pw_gid == 0 or plan['user'] != 'aistudy-worker' or plan['group'] != 'aistudy-worker':
            raise PermissionError('Worker identity unavailable')
        os.initgroups(account.pw_name, account.pw_gid)
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    elif plan['user'] or plan['group']:
        raise PermissionError('Web credential profile requires explicit review')
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('HERMES_', 'PYTHON', 'LD_')) and key not in ('NODE_OPTIONS', 'NODE_PATH')}
    os.execve('/usr/bin/node', argv, environment)


def main():
    if len(sys.argv) != 3 or os.geteuid() != 0:
        raise PermissionError('Root helper arguments required')
    peer = controls()
    state, unit = sys.argv[1:]
    plan, target_fd = admit(peer, state, unit)
    execute(plan, target_fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Writer execution refused by trusted admission', file=sys.stderr)
        sys.exit(1)
