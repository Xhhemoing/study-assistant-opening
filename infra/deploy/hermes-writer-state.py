#!/usr/bin/python3
"""Protocol 2 local admission/receipt classifier. Trust is root DAC, NOT a MAC.

Release scripts already execute as root: this protocol does not contain hostile
root release code. No session token is needed for durable boot classification.
"""
import errno
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

# Fixed in production. Tests may replace the module object, never environment/CLI.
TRUSTED_UID = 0


def identity(st):
    return [st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_nlink]


def safe_open(path, private=False, directory=False):
    """Walk from / using dirfds; no symlink, writable parent or hardlink input."""
    path = os.fspath(path)
    if not path.startswith('/') or os.path.normpath(path) != path:
        raise ValueError('Noncanonical trusted path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = path.split('/')[1:]
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            child = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                            (os.O_DIRECTORY if not final or directory else 0), dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            # /tmp is allowed only as a root-owned sticky *ancestor* in local tests.
            sticky = not final and stat.S_ISDIR(st.st_mode) and st.st_mode & stat.S_ISVTX
            trusted_owner = st.st_uid == TRUSTED_UID if final else st.st_uid in (0, TRUSTED_UID)
            if not trusted_owner or (st.st_mode & 0o022 and not sticky):
                raise PermissionError('Untrusted path owner/mode')
            if final:
                if private and st.st_mode & 0o077:
                    raise PermissionError('Private state is not private')
                if not directory and (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1):
                    raise PermissionError('Trusted file must be regular and single-link')
        result, fd = fd, -1
        return result
    finally:
        if fd >= 0:
            os.close(fd)


def read_trusted(path, private=False, sync=False):
    fd = safe_open(path, private)
    try:
        before = identity(os.fstat(fd))
        with os.fdopen(os.dup(fd), 'rb') as source:
            data = source.read()
        if sync:
            os.fsync(fd)
        if before != identity(os.fstat(fd)) or before != identity(os.lstat(path)):
            raise ValueError('Trusted file changed')
        return data, before
    finally:
        os.close(fd)


def sync_dir(path):
    fd = safe_open(path, directory=True)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def present(path):
    try:
        os.lstat(path)
        return True
    except OSError as error:
        if error.errno == errno.ENOENT:
            return False
        raise


def guards(state):
    return any(present(Path(state) / name) for name in ('migration-forward-only', 'writers-fenced'))


def validate_config(config, sync=False):
    for entry in config['files']:
        _, actual = read_trusted(entry['path'], sync=sync)
        if actual != entry['identity']:
            raise ValueError('Configuration identity changed')
    if sync:
        for directory in sorted({str(Path(e['path']).parent) for e in config['files']}):
            sync_dir(directory)


def classify(state, current, broker, scope=None, sync=False):
    """Read-only. Does not remove guards, execute writers, or infer commit from health."""
    safe = safe_open(state, private=True, directory=True)
    os.close(safe)
    if present(broker):
        return 'grant-required'
    if guards(state) or present(Path(state) / 'activation-incomplete'):
        return 'fenced'
    marker = Path(state) / 'protocol2-transition.json'
    if not present(marker):
        return 'legacy'
    binding = json.loads(read_trusted(marker, private=True)[0])
    if binding['protocol'] != 2:
        raise ValueError('Unknown protocol')
    if scope is not None and any(binding.get(k) != v for k, v in scope.items()):
        return 'unknown'
    receipt_path = Path(state) / 'commit-receipts' / (binding['owner'] + '.json')
    if not isinstance(binding['owner'], str) or len(binding['owner']) != 32 or any(c not in '0123456789abcdef' for c in binding['owner']):
        raise ValueError('Invalid receipt scope')
    receipt = json.loads(read_trusted(receipt_path, private=True, sync=sync)[0])
    if receipt != {**binding, 'phase': 'terminal'} or os.path.realpath(current) != receipt['target']:
        return 'unknown'
    target_stat = os.stat(receipt['target'])
    if [target_stat.st_dev, target_stat.st_ino] != receipt['targetIdentity']:
        return 'unknown'
    validate_config(receipt['config'], sync=sync)
    if sync:
        sync_dir(receipt_path.parent)
        sync_dir(state)
        sync_dir(Path(current).parent)
    # Repeat the whole classification after persistence; no positive memory cache.
    if sync:
        return classify(state, current, broker, scope, False)
    return 'committed'


def durable_write(path, value):
    path = Path(path)
    parent = safe_open(path.parent, private=True, directory=True)
    os.close(parent)
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(value, sort_keys=True) + '\n').encode())
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


def commit(state, current, broker, binding):
    """Synchronous boundary: caller has completed health/config and closed broker.

    Receipt -> G unlink+dirfsync -> F unlink+dirfsync LAST. Faults leave refusal;
    the owner must refence and independently stop both, never restore old code.
    """
    if present(broker) or os.path.realpath(current) != binding['target']:
        raise ValueError('Commit scope changed or broker still open')
    validate_config(binding['config'], sync=True)
    receipts = Path(state) / 'commit-receipts'
    receipts.mkdir(mode=0o700, exist_ok=True)
    sync_dir(state)
    durable_write(receipts / (binding['owner'] + '.json'), {**binding, 'phase': 'terminal'})
    for name in ('migration-forward-only', 'writers-fenced'):
        path = Path(state) / name
        if present(path):
            os.unlink(path)
        sync_dir(state)
    if classify(state, current, broker, sync=True) != 'committed':
        raise ValueError('Commit not provable')


def main():
    mode, state, current, broker = sys.argv[1:5]
    payload = json.load(sys.stdin) if mode in ('commit', 'query') else None
    if mode == 'commit':
        commit(state, current, broker, payload)
    elif mode in ('classify', 'query'):
        print(classify(state, current, broker, payload, sync=True))
    else:
        raise ValueError('Unknown classifier action')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never print raw scope, token, environment or file contents.
        print('unknown')
        sys.exit(1)
