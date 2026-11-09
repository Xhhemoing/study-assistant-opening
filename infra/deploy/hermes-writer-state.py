#!/usr/bin/python3
"""Protocol 2 local admission/receipt classifier. Trust is root DAC, NOT a MAC.

Release scripts already execute as root: this protocol does not contain hostile
root release code. No session token is needed for durable boot classification.
"""
import errno
import json
import os
from pathlib import Path
import sys
import tempfile

# Fixed in production. Tests may replace the module object, never environment/CLI.
TRUSTED_UID = 0


# Injected only by the fixed stdlib entry after complete source verification.
identity = bootstrap.identity


def safe_open(path, private=False, directory=False):
    return bootstrap.safe_open(path, private, directory, uid=TRUSTED_UID)


def read_trusted(path, private=False, sync=False):
    return bootstrap.read_trusted(path, private, sync, uid=TRUSTED_UID)


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
    if 'effective' in config:
        # One implementation for boot/query and online admission; no permissive
        # production adapter fallback when systemd is unavailable.
        module = trusted_loader.load('hermes-peer-broker.py')
        manager = module.SystemdManager()
        for unit, expected in config['effective'].items():
            if manager.configuration(unit) != expected:
                raise ValueError('Effective manager configuration changed')


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
    binding = json.loads(read_trusted(marker, private=True, sync=sync)[0])
    if binding['protocol'] != 2:
        raise ValueError('Unknown protocol')
    if scope is not None and any(binding.get(k) != v for k, v in scope.items()):
        return 'unknown'
    receipts_fd = safe_open(Path(state) / 'commit-receipts', private=True, directory=True)
    os.close(receipts_fd)
    if not isinstance(binding['owner'], str) or len(binding['owner']) != 32 or any(c not in '0123456789abcdef' for c in binding['owner']):
        raise ValueError('Invalid receipt scope')
    receipt_path = Path(state) / 'commit-receipts' / (binding['owner'] + '.json')
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
        data = memoryview((json.dumps(value, sort_keys=True) + '\n').encode())
        while data:
            written = os.write(fd, data)
            if written <= 0:
                raise OSError('Receipt write incomplete')
            data = data[written:]
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
    marker = json.loads(read_trusted(Path(state) / 'protocol2-transition.json', private=True, sync=True)[0])
    if marker != binding:
        raise ValueError('Terminal binding changed')
    if present(broker) or os.path.realpath(current) != binding['target']:
        raise ValueError('Commit scope changed or broker still open')
    validate_config(binding['config'], sync=True)
    receipts = Path(state) / 'commit-receipts'
    receipts.mkdir(mode=0o700, exist_ok=True)
    sync_dir(state)
    durable_write(receipts / (binding['owner'] + '.json'), {**binding, 'phase': 'terminal'})
    # Incomplete is itself a boot barrier. Retire it only after the terminal
    # receipt is durable, before G and the final F removal.
    for name in ('activation-incomplete', 'migration-forward-only', 'writers-fenced'):
        path = Path(state) / name
        if present(path):
            os.unlink(path)
        sync_dir(state)
    if classify(state, current, broker, sync=True) != 'committed':
        raise ValueError('Commit not provable')


def main():
    mode, state, current, broker = sys.argv[1:5]
    if mode == 'check-plan':
        plan = json.loads(read_trusted(Path(state) / ('writer-' + broker + '.json'), private=True)[0])
        if plan['unit'] != broker or plan['target'] != current:
            raise ValueError('Plan scope mismatch')
        validate_config(plan['config'])
        return
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
