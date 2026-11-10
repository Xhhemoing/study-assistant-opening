#!/usr/bin/python3
"""Protocol 2 local admission/receipt classifier. Trust is root DAC, NOT a MAC.

Release scripts already execute as root: this protocol does not contain hostile
root release code. No session token is needed for durable boot classification.
"""
import errno
import json
import os
import re
import subprocess
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


# Reviewed persistent profile. Runtime /run inputs have no boot-persistence proof.
# Object-only test seam, never supplied by a plan, receipt, environment or CLI.
RESOURCE_ROOTS = {'/etc/systemd/system': '/etc/systemd/system.control'}
RESOURCE_KEYS = ('MemoryMax', 'MemoryHigh')
WORKER = 'aistudy-worker.service'
LEGACY_CWD = '49-aistudy-legacy-cwd.conf'
LEGACY_CWD_BYTES = b'[Service]\nWorkingDirectory=/opt/aistudy\n'


def resource_paths(systemd):
    control = RESOURCE_ROOTS.get(systemd)
    if control is None:
        return {}
    return {str(Path(systemd) / (WORKER + '.d') / 'memory.conf'): 'memory',
            str(Path(control) / (WORKER + '.d') / '50-MemoryHigh.conf'): 'control-high'}


def memory_bytes(value):
    # systemd's integer binary suffixes; percentages, fractions, infinity and
    # UINT64_MAX (the infinity sentinel) are deliberately outside this profile.
    match = re.fullmatch(r'(0|[1-9][0-9]*)([KMGTPE]?)', value, flags=re.ASCII)
    if not match:
        raise ValueError('Unsupported memory value')
    result = int(match[1]) * 1024 ** ('KMGTPE'.index(match[2]) + 1 if match[2] else 0)
    if not 0 < result < 2**64 - 1:
        raise ValueError('Memory value outside finite profile')
    return str(result)


def resource_directives(data, fragment=False):
    if not data or any(byte not in (9, 10) and not 32 <= byte <= 126 for byte in data):
        raise ValueError('Non-ASCII resource input')
    section, seen_service, result = None, False, {}
    for raw in data.decode('ascii').split('\n'):
        line = raw.strip(' \t')
        if '\\' in line or (not fragment and '%' in line):
            raise ValueError('Escaped resource input')
        if not line or line.startswith(('#', ';')):
            continue
        if line.startswith('['):
            if (not fragment and (line != '[Service]' or seen_service)) or (line == '[Service]' and seen_service):
                raise ValueError('Unknown or duplicate resource section')
            section = line
            if line == '[Service]':
                seen_service = True
            continue
        key, separator, value = line.partition('=')
        key, value = key.strip(' \t'), value.strip(' \t')
        if fragment and (section != '[Service]' or key not in RESOURCE_KEYS):
            continue
        if section != '[Service]' or not separator or key not in RESOURCE_KEYS or key in result:
            raise ValueError('Unknown, duplicate or misplaced resource directive')
        result[key] = memory_bytes(value)
    if not result:
        raise ValueError('Empty resource input')
    return result


def resource_binding(systemd, effective, contents):
    """Pure byte policy, also used before old units have 95/96 installed.

    Admission/receipt callers additionally enforce installed inputs in
    validate_resources; contents are descriptor-captured, not paths to trust.
    """
    if systemd not in RESOURCE_ROOTS:
        raise ValueError('Unknown or nonpersistent resource profile')
    paths = resource_paths(systemd)
    rows = []
    for unit, values in sorted(effective.items()):
        drops = values['DropInPaths'].split(' ') if values['DropInPaths'] else []
        known = [str(Path(systemd) / (unit + '.d') / name) for name in
                 (('50-aistudy-release.conf' if unit == 'aistudy-web.service' else '90-aistudy-protocol-guard.conf'),
                  '95-aistudy-migration-fence.conf', '96-aistudy-writer-exec.conf')]
        legacy = str(Path(systemd) / (unit + '.d') / LEGACY_CWD)
        if unit == 'aistudy-web.service':
            known.append(legacy)
        fragment = str(Path(systemd) / unit)
        if (unit not in ('aistudy-web.service', WORKER) or values['FragmentPath'] != fragment
                or len(drops) != len(set(drops))
                or any(path not in known and (unit != WORKER or path not in paths) for path in drops)):
            raise ValueError('Unknown effective unit input')
        if legacy in drops:
            if known[0] not in drops or contents[legacy] != LEGACY_CWD_BYTES:
                raise ValueError('Unreviewed legacy working directory input')
            rows.append({'unit': unit, 'inputs': [{'path': legacy, 'bytes': contents[legacy].hex()}], 'effective': {}})
        resources = [path for path in drops if path in paths]
        if not resources:
            continue
        limits = resource_directives(contents[fragment], fragment=True)
        if limits != {'MemoryMax': '1073741824', 'MemoryHigh': '939524096'}:
            raise ValueError('Unreviewed worker fragment resource base')
        inputs = []
        # systemd orders drop-ins by basename, irrespective of directory. This
        # profile has unique basenames, so no directory-precedence ambiguity.
        for path in sorted(drops, key=lambda value: Path(value).name):
            data = contents[path]
            if path not in resources:
                # Fixed execution/guard files cannot secretly override resources.
                if re.search(rb'(?m)^[ \t]*Memory[A-Za-z]*[ \t]*=', data):
                    raise ValueError('Resource override outside reviewed profile')
                continue
            parsed = resource_directives(data)
            if paths[path] == 'control-high' and parsed != {'MemoryHigh': '2147483648'}:
                raise ValueError('Unreviewed control MemoryHigh')
            limits.update(parsed)
            inputs.append({'path': path, 'directives': parsed, 'bytes': data.hex()})
        actual = {key: values.get(key) for key in RESOURCE_KEYS}
        if actual != limits:
            raise ValueError('Resource input/effective mismatch')
        # MemoryHigh > MemoryMax is valid systemd input: retain the actual pair,
        # do not invent a clamped effective value or rewrite production settings.
        rows.append({'unit': unit, 'inputs': inputs, 'effective': limits})
    return {'profile': 'worker-persistent-memory-v1', 'systemd': systemd, 'units': rows} if rows else None


def validate_resources(config, contents):
    binding = config.get('resourceBinding')
    effective = config.get('effective', {})
    for unit, values in effective.items():
        fragment = values['FragmentPath']
        drops = values['DropInPaths'].split()
        legacy = str(Path(fragment).parent / (unit + '.d') / LEGACY_CWD)
        primary = str(Path(fragment).parent / (unit + '.d') /
                      ('50-aistudy-release.conf' if unit == 'aistudy-web.service' else '90-aistudy-protocol-guard.conf'))
        if binding is not None and primary not in drops:
            raise ValueError('Missing required release/guard input')
        if unit == 'aistudy-web.service' and legacy in drops:
            if contents.get(legacy) != LEGACY_CWD_BYTES or binding is None:
                raise ValueError('Missing or unreviewed legacy working directory binding')
        if any(Path(path).name in ('memory.conf', '50-MemoryHigh.conf') for path in drops):
            required = [str(Path(fragment).parent / (unit + '.d') / name) for name in
                        ('90-aistudy-protocol-guard.conf', '95-aistudy-migration-fence.conf', '96-aistudy-writer-exec.conf')]
            if any(path not in drops for path in required):
                raise ValueError('Missing required execution/guard input')
    if binding is None:
        # Old receipts cannot acquire a new unbound resource input at boot.
        for values in effective.values():
            fragment = values['FragmentPath']
            unit = Path(fragment).name
            if unit not in ('aistudy-web.service', WORKER):
                raise ValueError('Unknown configuration fragment')
            known = {str(Path(fragment).parent / (unit + '.d') / name) for name in
                     ('50-aistudy-release.conf' if unit == 'aistudy-web.service' else '90-aistudy-protocol-guard.conf',
                      '95-aistudy-migration-fence.conf', '96-aistudy-writer-exec.conf')}
            if any(path not in known for path in values['DropInPaths'].split()):
                raise ValueError('Missing resource binding')
        return
    if resource_binding(binding['systemd'], effective, contents) != binding:
        raise ValueError('Resource binding changed')
    required = {row['path'] for unit in binding['units'] for row in unit['inputs']}
    entries = {entry['path']: entry for entry in config['files']}
    if any(path not in entries or not entries[path].get('ancestors') for path in required):
        raise ValueError('Missing resource ancestor binding')


def validate_config(config, sync=False):
    contents = {}
    for entry in config['files']:
        data, actual = read_trusted(entry['path'], sync=sync)
        contents[entry['path']] = data
        if actual != entry['identity']:
            raise ValueError('Configuration identity changed')
        if Path(entry['path']).name == LEGACY_CWD:
            if (Path(entry['path']).parent.name != 'aistudy-web.service.d'
                    or data != LEGACY_CWD_BYTES or not entry.get('ancestors')):
                raise ValueError('Unreviewed or unbound legacy working directory input')
        if 'ancestors' in entry:
            paths = [str(parent) for parent in reversed(Path(entry['path']).parents)]
            if [row['path'] for row in entry['ancestors']] != paths:
                raise ValueError('Incomplete configuration ancestors')
            for row in entry['ancestors']:
                # read_trusted already checks descriptor-relative DAC; bind each
                # directory's identity too, including same-byte parent swaps.
                st = os.lstat(row['path'])
                value = ':'.join(str(value) for value in (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid))
                if value != row['identity']:
                    raise ValueError('Configuration ancestor changed')
    for unit, values in config.get('effective', {}).items():
        environments = [path for path in contents if Path(path).name == '.env.production']
        runtimes = [path for path in contents if Path(path).name == 'worker-runtime.env']
        if len(environments) != 1 or unit not in ('aistudy-web.service', WORKER):
            raise ValueError('Missing or ambiguous environment binding')
        expected = environments[0] + ' (ignore_errors=no)'
        if unit == WORKER:
            if len(runtimes) != 1:
                raise ValueError('Missing or ambiguous runtime environment binding')
            expected += ' ' + runtimes[0] + ' (ignore_errors=no)'
        if values.get('EnvironmentFiles') not in ([expected, expected + ' ' + expected] if unit == 'aistudy-web.service' else [expected]):
            raise ValueError('Unreviewed environment input')
    validate_resources(config, contents)
    if sync:
        for directory in sorted({str(Path(e['path']).parent) for e in config['files']}):
            sync_dir(directory)
        for entry in config['files']:
            if 'ancestors' not in entry:
                continue
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                for row in entry['ancestors']:
                    if row['path'] != '/':
                        child = os.open(Path(row['path']).name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        os.close(fd)
                        fd = child
                    st = os.fstat(fd)
                    actual = ':'.join(str(value) for value in (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid))
                    if actual != row['identity']:
                        raise ValueError('Configuration ancestor changed during persistence')
                    os.fsync(fd)
            finally:
                os.close(fd)
        # Close the cross-file/fsync window before trusting the effective snapshot.
        validate_config(config, sync=False)
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


# Deliberately one incident, one pre-migration adoption. This is NOT a resume
# protocol. A future incident needs independent review, not another caller flag.
REPAIR_BASELINE = '6afaaa70d3467da4f17daaad44a99e2d36b9f991'
REPAIR_INCIDENT = '20261110T024515-679352'


def repair_check(state, current, systemd):
    """Read-only filesystem/manager admission; no fsync, mkdir, stop or DB claim.

    The database is checked again after a NEW full backup by the adopted owner.
    A generic forward-armed/crash reason is not a durable migration boundary.
    This historical incident is allowed only because it predates runner entry;
    new owners persist migration-armed BEFORE acknowledging arm.
    """
    state = Path(state)
    fd = safe_open(state, private=True, directory=True)
    os.close(fd)
    guard = json.loads(read_trusted(state / 'migration-forward-only', private=True)[0])
    transition = state / 'releases' / REPAIR_INCIDENT
    if guard != {'transition': str(transition), 'reason': 'owner exited without durable success', 'ownerPid': 679352}:
        raise ValueError('Not the reviewed pre-migration incident')
    # Refuse even PID reuse: absence, not signalling or guessed start identity.
    if present('/proc/679352'):
        raise ValueError('Incident owner death not proven')
    fd = safe_open(transition, private=True, directory=True)
    os.close(fd)
    read_trusted(state / 'writers-fenced', private=True)
    if read_trusted(state / 'activation-incomplete', private=True)[0] != (str(transition) + '\n').encode():
        raise ValueError('Incident activation binding changed')
    old = read_trusted(transition / 'from-target', private=True)[0].decode().strip()
    if os.path.realpath(current) != old:
        raise ValueError('Incident current target changed')
    old_sha = read_trusted(Path(old) / '.release-sha')[0].decode().strip()
    if not re.fullmatch(r'1e511[0-9a-f]{35}', old_sha):
        raise ValueError('Incident old release identity changed')
    previous = state / 'releases' / '20261108T160832-39068'
    if os.path.realpath(state / 'last-transition') != str(previous):
        raise ValueError('Incident last transition changed')
    backup = read_trusted(transition / 'database-backup', private=True)[0].decode().strip()
    if not Path(backup).name.startswith(REPAIR_BASELINE + '-'):
        raise ValueError('Original baseline backup binding missing')
    fd = safe_open(backup, private=True)
    try:
        if os.fstat(fd).st_size == 0:
            raise ValueError('Original backup empty')
    finally:
        os.close(fd)
    for path in [state / 'repair-adopted', state / 'protocol2-transition.json', state / 'writer-controls',
                 state / 'commit-receipts', Path('/run/aistudy-writer-broker'),
                 *[transition / name for name in ('migration-plan.json', 'migration-armed', 'migration-succeeded',
                                                  'repair-adopted', 'succeeded', 'degraded', 'to-target')]]:
        if present(path):
            raise ValueError('Incident crossed a boundary or adoption already consumed')
    manager = trusted_loader.load('hermes-peer-broker.py').SystemdManager()
    effective, contents = {}, {}
    for unit in ('aistudy-web.service', WORKER):
        # Reuse the reviewed raw ExecStart/ordered EnvironmentFiles parser, not
        # a dict that loses repeated manager records. No relaxed repair adapter.
        values = manager.configuration(unit)
        expected_env = '/opt/aistudy/.env.production (ignore_errors=no)'
        if unit == WORKER:
            expected_env += ' /etc/aistudy/worker-runtime.env (ignore_errors=no)'
        if values['EnvironmentFiles'] not in ([expected_env, expected_env + ' ' + expected_env]
                                              if unit != WORKER else [expected_env]):
            raise ValueError('Unreviewed repair environment input')
        effective[unit] = values
        # resource_binding below owns the complete fragment/drop-in allowlist,
        # duplicate rejection, legacy bytes and persistent memory policy.
        for path in [values['FragmentPath'], *values['DropInPaths'].split(' ')]:
            if path:
                contents[path] = read_trusted(path)[0]
        directory = Path(systemd) / (unit + '.d')
        fence = directory / '95-aistudy-migration-fence.conf'
        expected = ('[Unit]\nConditionPathExists=!' + str(state / 'writers-fenced') + '\n').encode()
        if read_trusted(fence)[0] != expected or present(directory / '96-aistudy-writer-exec.conf'):
            raise ValueError('Historical fence configuration changed')
        # Conditions is a typed D-Bus array in systemd 249. Query the actual
        # effective list: an on-disk 95 alone cannot prove a live boot barrier.
        object_path = '/org/freedesktop/systemd1/unit/' + unit.replace('-', '_2d').replace('.', '_2e')
        result = subprocess.run(['/usr/bin/busctl', '--system', '--json=short', 'get-property',
                                 'org.freedesktop.systemd1', object_path,
                                 'org.freedesktop.systemd1.Unit', 'Conditions'],
                                check=True, capture_output=True, text=True, timeout=5)
        conditions = json.loads(result.stdout)
        rows = conditions.get('data')
        if conditions.get('type') != 'a(sbbsi)' or not isinstance(rows, list):
            raise ValueError('Unknown effective conditions')
        for row in rows:
            if (not isinstance(row, list) or len(row) != 5
                    or not isinstance(row[0], str) or type(row[1]) is not bool
                    or type(row[2]) is not bool or not isinstance(row[3], str)
                    or type(row[4]) is not int):
                raise ValueError('Malformed effective condition')
        matches = [row for row in rows if row[0] == 'ConditionPathExists'
                   and row[3] == str(state / 'writers-fenced')]
        if len(matches) != 1 or matches[0][1:3] != [False, True]:
            raise ValueError('Effective negative fence condition missing or changed')
        result = subprocess.run(['/usr/bin/systemctl', 'show', '--all',
                                 '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup,NeedDaemonReload,DropInPaths', unit],
                                check=True, capture_output=True, text=True, timeout=5)
        pairs = [line.split('=', 1) for line in result.stdout.splitlines()]
        values = dict(pairs)
        required = {'LoadState': 'loaded', 'MainPID': '0', 'ControlPID': '0', 'Job': '', 'NeedDaemonReload': 'no'}
        if (set(values) != set(required) | {'ActiveState', 'SubState', 'ControlGroup', 'DropInPaths'}
                or len(pairs) != len(values) or any(values.get(key) != value for key, value in required.items())
                or values.get('ActiveState') not in ('inactive', 'failed')
                or values.get('SubState') not in ('dead', 'failed')
                or values.get('DropInPaths') != effective[unit]['DropInPaths']
                or str(fence) not in values.get('DropInPaths', '').split(' ')):
            raise ValueError('Historical fence/stopped manager state unconfirmed')
        group = values.get('ControlGroup')
        if group is None or not present('/sys/fs/cgroup/cgroup.controllers'):
            raise ValueError('Unknown cgroup layout')
        if group:
            if not re.fullmatch(r'/[A-Za-z0-9_.@:/-]+', group) or '..' in group:
                raise ValueError('Unknown cgroup path')
            root = Path('/sys/fs/cgroup' + group)
            def walk_error(error):
                raise error
            for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
                if any(Path(directory, name).is_symlink() for name in dirs + files):
                    raise ValueError('Unknown cgroup link')
                if Path(directory, 'cgroup.procs').read_text().strip():
                    raise ValueError('Writer cgroup not empty')
            if not (root / 'cgroup.procs').is_file():
                raise ValueError('Writer cgroup unavailable')
        if manager.configuration(unit) != effective[unit]:
            raise ValueError('Repair manager inputs changed during observation')
    resource_binding(systemd, effective, contents)
    return {'eligible': True, 'scope': 'pre-migration-filesystem-manager-only',
            'baseline': REPAIR_BASELINE, 'incident': str(transition), 'automaticRetry': False}


def main():
    if sys.argv[1:] == ['resource-policy']:
        payload = json.load(sys.stdin)
        contents = {row['path']: bytes.fromhex(row['bytes']) for row in payload['files']}
        print(json.dumps(resource_binding(payload['systemd'], payload['effective'], contents)))
        return
    mode, state, current, broker = sys.argv[1:5]
    if mode == 'repair-check':
        print(json.dumps(repair_check(state, current, broker)))
        return
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
