#!/usr/bin/python3
"""Protocol 2 local admission/receipt classifier. Trust is root DAC, NOT a MAC.

Release scripts already execute as root: this protocol does not contain hostile
root release code. No session token is needed for durable boot classification.
"""
import errno
import hashlib
import tarfile
import json
import os
import re
import subprocess
import pwd
from pathlib import Path
import sys
import tempfile
import time

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
    check_historical_manager(state, systemd)
    return {'eligible': True, 'scope': 'pre-migration-filesystem-manager-only',
            'baseline': REPAIR_BASELINE, 'incident': str(transition), 'automaticRetry': False}


def check_historical_manager(state, systemd):
    """Shared read-only 95-era manager policy; no adoption or migration policy."""
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


COMPLETION_INCIDENT = '20261110T081511-846613'
COMPLETION_SHA = 'e5bab172cee9b7a3bf6b165b01f8d56aea7e66cf'
COMPLETION_OWNER = '87923d3e5822888a889e9349fa7a778e'
COMPLETION_ARCHIVE_SHA = '4136bafe71484359263128af46d8ddadfe7e9e0227a0976d3f3858f3b9d2b0a0'
COMPLETION_BACKUP_SIZE = 537911
COMPLETION_BACKUP_SHA = 'cf8f522929b4e62fb933b179ed587c383c6ffcb0e154dd6807755ef495672485'


def strict_json(data):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def completion_stream_sha256(source):
    """Python 3.10 compatible, bounded reads for retained and installed bytes."""
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            return size, digest.digest()
        size += len(chunk)
        digest.update(chunk)


def completion_payload_file(path, member, source):
    fd = safe_open(path)
    try:
        before = identity(os.fstat(fd))
        st = os.fstat(fd)
        if st.st_size != member.size or st.st_mode & 0o777 != member.mode & 0o777:
            raise ValueError('Payload size/mode changed')
        with os.fdopen(os.dup(fd), 'rb') as installed:
            actual = completion_stream_sha256(installed)
        if actual != completion_stream_sha256(source) or actual[0] != member.size:
            raise ValueError('Existing payload differs from signed e5')
        check = safe_open(path)
        try:
            if before != identity(os.fstat(fd)) or before != identity(os.fstat(check)):
                raise ValueError('Payload changed during comparison')
        finally:
            os.close(check)
    finally:
        os.close(fd)


class CompletionPayloadExtras(ValueError):
    pass


def completion_payload(release, config, archive):
    """Incident-only full byte inventory against the retained, signed e5 gzip.

    Not a change to verifyTree/artifact admission. The sole deployment extras are
    the existing config link and release SHA; no wildcard extra exclusions.
    """
    fd = safe_open(archive)
    archive_identity = identity(os.fstat(fd))
    try:
        with os.fdopen(os.dup(fd), 'rb') as source:
            if completion_stream_sha256(source)[1].hex() != COMPLETION_ARCHIVE_SHA:
                raise ValueError('Retained e5 gzip digest changed')
        os.lseek(fd, 0, os.SEEK_SET)
        # One forward decompression pass: getmembers()+random extraction seeks
        # backwards in gzip for each file. Never retain/read a whole payload file.
        with os.fdopen(os.dup(fd), 'rb') as source, tarfile.open(fileobj=source, mode='r|gz') as tar:
            names = set()
            count, total = 0, 0
            for member in tar:
                count += 1
                total += member.size
                if count > 300000 or member.size < 0 or total > 12 * 1024**3:
                    raise ValueError('Retained inventory exceeds release limits')
                # Python 3.10 caches TarInfo even in stream mode. The names set
                # owns duplicate detection; no later extraction needs this cache.
                tar.members.clear()
                name = member.name.rstrip('/') if member.isdir() else member.name
                if (name in ('.env.production', '.release-sha') or not name or name.startswith('/') or '\\' in name
                        or any(c in ('', '.', '..') for c in name.split('/'))
                        or any(ord(c) < 32 or ord(c) == 127 for c in name)
                        or name in names or not (member.isdir() or member.isfile())
                        or member.mode & 0o7022 or member.sparse):
                    raise ValueError('Unsafe retained inventory')
                names.add(name)
                path = Path(release) / name
                if member.isdir():
                    directory = safe_open(path, directory=True)
                    try:
                        if os.fstat(directory).st_mode & 0o777 != member.mode & 0o777:
                            raise ValueError('Payload directory mode changed')
                    finally:
                        os.close(directory)
                    continue
                with tar.extractfile(member) as payload:
                    completion_payload_file(path, member, payload)
            observed, unknown = set(), set()
            for directory, dirs, entries in os.walk(release, followlinks=False):
                for name in dirs + entries:
                    path = Path(directory) / name
                    key = str(path.relative_to(release))
                    observed.add(key)
                    if key not in names and key not in ('.env.production', '.release-sha'):
                        unknown.add(key)
                    if key in names and path.is_symlink():
                        raise ValueError('Payload link changed')
            extras = {'.env.production'}
            if present(Path(release) / '.release-sha'):
                extras.add('.release-sha')
            if observed != names | extras | unknown:
                raise ValueError('Incomplete existing inventory')
        check = safe_open(archive)
        try:
            if archive_identity != identity(os.fstat(fd)) or archive_identity != identity(os.fstat(check)):
                raise ValueError('Retained archive changed during comparison')
        finally:
            os.close(check)
    finally:
        os.close(fd)
    if os.readlink(Path(release) / '.env.production') != config:
        raise ValueError('Unexpected payload config link')
    if present(Path(release) / '.release-sha') and read_trusted(Path(release) / '.release-sha')[0] != (COMPLETION_SHA + '\n').encode():
        raise ValueError('Unexpected payload release SHA')
    if unknown:
        # Signed bytes and retained identity were fully compared. This remains
        # a strict rejection, but readonly DB reporting may use those verified
        # modules without treating extras as approved payload inventory.
        error = CompletionPayloadExtras('Unknown payload deployment extra')
        prefix = 'services/parser/opening_parser/__pycache__'
        generated = {prefix, *[prefix + '/' + name for name in (
            '__main__.cpython-312.pyc', '__init__.cpython-312.pyc',
            'ocr.cpython-312.pyc', 'physical_pages.cpython-312.pyc')]}
        error.only_observed_generated = unknown == generated
        raise error
    return {'archiveSha256': COMPLETION_ARCHIVE_SHA, 'archiveBytes': os.stat(archive).st_size,
            'memberCount': count, 'memberBytes': total, 'gzipInventoryPasses': 1,
            'hashChunkBytes': 1024 * 1024}


def completion_generated_observation(release):
    """Readonly evidence only. NEVER an exclusion, admission or cleanup grant."""
    directory = Path(release) / 'services/parser/opening_parser/__pycache__'
    expected = {'__main__.cpython-312.pyc': 11718, '__init__.cpython-312.pyc': 284,
                'ocr.cpython-312.pyc': 6519, 'physical_pages.cpython-312.pyc': 8252}
    if not present(directory):
        return {'present': False, 'admission': False, 'quarantineAuthorized': False}
    fd = safe_open(directory, directory=True, private=True)
    try:
        before = identity(os.fstat(fd))
        if os.fstat(fd).st_mode & 0o777 != 0o700 or set(os.listdir(fd)) != set(expected):
            raise ValueError('Generated directory metadata/inventory changed')
        rows = []
        for name, size in expected.items():
            path = directory / name
            file = safe_open(path, private=True)
            try:
                st = os.fstat(file)
                original = identity(st)
                if st.st_mode & 0o777 != 0o600 or st.st_size != size:
                    raise ValueError('Generated file metadata changed')
                with os.fdopen(os.dup(file), 'rb') as source:
                    length, digest = completion_stream_sha256(source)
                check = safe_open(path, private=True)
                try:
                    if original != identity(os.fstat(file)) or original != identity(os.fstat(check)) or length != size:
                        raise ValueError('Generated file changed during observation')
                finally:
                    os.close(check)
                rows.append({'path': str(path.relative_to(release)), 'uid': st.st_uid, 'gid': st.st_gid,
                             'mode': oct(st.st_mode & 0o777), 'nlink': st.st_nlink, 'size': size,
                             'sha256': digest.hex(), 'identity': original})
            finally:
                os.close(file)
        check = safe_open(directory, directory=True, private=True)
        try:
            if before != identity(os.fstat(fd)) or before != identity(os.fstat(check)) or set(os.listdir(fd)) != set(expected):
                raise ValueError('Generated directory changed during observation')
        finally:
            os.close(check)
        return {'admission': False, 'quarantineAuthorized': False, 'directoryIdentity': before, 'files': rows}
    finally:
        os.close(fd)


def completion_incident_check(state, current, systemd, release, config, archive, worker_config):
    """Exact immutable incident/guard evidence; no policy mutations."""
    for path in (state, current, systemd, release, config, archive, worker_config):
        if not re.fullmatch(r'/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*', path) or os.path.normpath(path) != path or '/..' in path:
            raise ValueError('Unsafe completion path')
    # Configuration is a trust boundary, not merely a normalized path. This
    # shared admission runs before any database probe or exclusive claim.
    read_trusted(config, private=True)
    state, release = Path(state), Path(release)
    for path in (state, release, state / 'releases' / COMPLETION_INCIDENT):
        fd = safe_open(path, private=path != release, directory=True)
        os.close(fd)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', release.name) or not release.name.startswith(COMPLETION_SHA + '-'):
        raise ValueError('Wrong completion release')
    transition = state / 'releases' / COMPLETION_INCIDENT
    original = state / 'releases' / REPAIR_INCIDENT
    expected = {'eligible': True, 'scope': 'pre-migration-filesystem-manager-only',
                'baseline': REPAIR_BASELINE, 'incident': str(original), 'automaticRetry': False}
    adopted = strict_json(read_trusted(state / 'repair-adopted', private=True)[0])
    if (not isinstance(adopted, dict) or type(adopted.get('eligible')) is not bool
            or type(adopted.get('automaticRetry')) is not bool
            or adopted != {**expected, 'transition': str(transition), 'release': str(release), 'owner': COMPLETION_OWNER}):
        raise ValueError('Wrong completion adoption binding')
    transition_adoption = strict_json(read_trusted(transition / 'repair-adopted', private=True)[0])
    if (not isinstance(transition_adoption, dict) or type(transition_adoption.get('eligible')) is not bool
            or type(transition_adoption.get('automaticRetry')) is not bool or transition_adoption != expected):
        raise ValueError('Wrong transition adoption')
    guard = strict_json(read_trusted(state / 'migration-forward-only', private=True)[0])
    if guard != {'transition': str(original), 'reason': 'owner exited without durable success', 'ownerPid': 679352}:
        raise ValueError('Original forward guard changed')
    for pid in (679352, 842456, 842459, 846471, 846472, 846613, 846643):
        if present('/proc/' + str(pid)):
            raise ValueError('Known owner PID present, including reuse')
    read_trusted(state / 'writers-fenced', private=True)
    if read_trusted(state / 'activation-incomplete', private=True)[0] != (str(transition) + '\n').encode():
        raise ValueError('Completion activation binding changed')
    for name, literal in (('migration-armed', b'Migration execution authorized; outcome must be inspected.\n'),
                          ('forward-armed', b'Unknown/partial migration outcome requires forward repair.\n')):
        if read_trusted(transition / name, private=True)[0] != literal:
            raise ValueError('Completion armed boundary changed')
    old = read_trusted(transition / 'from-target', private=True)[0].decode().strip()
    if os.path.realpath(current) != old or not re.fullmatch(r'1e511[0-9a-f]{35}\n', read_trusted(Path(old) / '.release-sha')[0].decode()):
        raise ValueError('Completion current changed')
    if os.path.realpath(state / 'last-transition') != str(state / 'releases' / '20261108T160832-39068'):
        raise ValueError('Completion previous success changed')
    for path in (state / 'postmigration-completion-claimed', state / 'protocol2-transition.json',
                 state / 'writer-controls', state / 'commit-receipts', Path('/run/aistudy-writer-broker'),
                 *[transition / name for name in ('migration-succeeded', 'to-target', 'succeeded', 'degraded')]):
        if present(path):
            raise ValueError('Completion already consumed or unknown boundary')
    backup = read_trusted(transition / 'database-backup', private=True)[0].decode().strip()
    data, _ = read_trusted(backup, private=True)
    if (os.lstat(backup).st_mode & 0o777 != 0o600 or len(data) != COMPLETION_BACKUP_SIZE
            or hashlib.sha256(data).hexdigest() != COMPLETION_BACKUP_SHA):
        raise ValueError('Completion backup evidence changed')
    if read_trusted(transition / 'worker-required', private=True)[0] != b'1\n':
        raise ValueError('Completion requires both writers')
    return backup


def completion_backup_toc(backup):
    restore = '/usr/lib/postgresql/16/bin/pg_restore'
    version = subprocess.run([restore, '--version'], capture_output=True, timeout=5)
    if version.returncode != 0 or not re.fullmatch(rb'pg_restore \(PostgreSQL\) 16\.[0-9]+(?: [^\r\n]+)?\n?', version.stdout):
        raise ValueError('Actual PostgreSQL 16 pg_restore required; no restore attempted')
    result = subprocess.run([restore, '--list', backup], capture_output=True, timeout=15)
    if result.returncode != 0:
        raise ValueError('Backup TOC rejected; no restore attempted')
    return version.stdout.decode().strip()


def completion_check(state, current, systemd, release, config, archive, worker_config):
    """One independent postmigration observation; NEVER migration-succeeded."""
    backup = completion_incident_check(state, current, systemd, release, config, archive, worker_config)
    version = completion_backup_toc(backup)
    payload = completion_payload(str(release), config, archive)
    check_historical_manager(Path(state), systemd)
    capacity = completion_capacity(str(state), str(release), systemd, worker_config, archive, str(Path(backup).parent))
    return {'scope': 'postmigration-independent-observation', 'incident': str(Path(state) / 'releases' / COMPLETION_INCIDENT), 'capacity': capacity,
            'release': str(release), 'automaticRetry': False, 'payload': payload,
            'pgRestoreVersion': version}


COMPLETION_ENTRY_FILES = ('hermes-release.sh', 'hermes-supervisor.mjs', 'hermes-config-durability.mjs',
                          'hermes-db.mjs', 'hermes-health.mjs', 'hermes-writer-control.mjs',
                          'hermes-trusted-loader.py', 'hermes-writer-state.py', 'hermes-writer-exec.py',
                          'hermes-peer-broker.py')


def completion_control_inventory():
    return {name: len(read_trusted(trusted_loader.directory / name)[0]) for name in COMPLETION_ENTRY_FILES}


COMPLETION_CACHE = '/var/cache/aistudy-worker'


def completion_capacity(state, release, systemd, worker_config, archive, backup_directory):
    """No payload extraction/backup/cache migration; retain release/backup floor.

    The control transport is capped at 1 MiB compressed and 1 MiB extracted.
    Account both staging generations, installed wrappers, config snapshots and
    a bounded state/log allowance. Existing payload/gzip/dump consume space
    already reflected by statvfs; they are never copied by this action.
    """
    cache = Path(COMPLETION_CACHE)
    account = pwd.getpwnam('aistudy-worker')
    st = os.lstat(cache)
    if cache.is_symlink() or not cache.is_dir() or st.st_uid != account.pw_uid or account.pw_uid == 0:
        raise ValueError('Completion requires existing dedicated cache; no cache copy authorized')
    for path in (state, release, systemd, worker_config, str(Path(archive).parent), backup_directory):
        directory = safe_open(path, directory=True)
        os.close(directory)
    inventory = completion_control_inventory()
    if set(inventory) != set(COMPLETION_ENTRY_FILES) or any(type(v) is not int or v <= 0 for v in inventory.values()):
        raise ValueError('Incomplete completion controls capacity inventory')
    block = 4096
    allocated = sum(((size + block - 1) // block) * block for size in inventory.values())
    if sum(inventory.values()) > 1048576:
        raise ValueError('Completion controls exceed small closure capacity')
    # Reviewed Git controls/entry transport must stay <=1MiB; no new signed
    # controls artifact is required. No download/extraction happens here.
    # These are conservative budgets, not measured formal transport sizes.
    allocations = {'controlArchiveMax': 1048576, 'controlExtractionBlocks': allocated,
                   'controlStagingBlocks': allocated, 'writerControlsBlocks': allocated,
                   'configurationAndReceiptsMax': 2097152, 'runtimeAndJournalReserve': 33554432,
                   'newPayloadDownload': 0, 'newPayloadExtraction': 0, 'newBackup': 0, 'cacheCopy': 0}
    # Charge each write to its real filesystem, not the entire budget to every
    # observed mount. No root 6GiB policy is invented. Read-only gzip/cache/config
    # observations add no writes. Same-device allocations accumulate once.
    writes = (('/tmp', 'controlArchiveMax'), ('/tmp', 'controlExtractionBlocks'),
              ('/tmp', 'controlStagingBlocks'), (state, 'writerControlsBlocks'),
              (state, 'configurationAndReceiptsMax'), ('/var/log', 'runtimeAndJournalReserve'))
    mounts = {}
    def observe(path, floor=0):
        values = os.statvfs(path)
        device = str(os.stat(path).st_dev)
        free = values.f_bavail * values.f_frsize
        row = mounts.setdefault(device, {'device': device, 'availableBytes': free,
            'additionalPeakBudgetBytes': 0, 'retainedFloorBytes': 0, 'writes': {}})
        row['availableBytes'] = min(row['availableBytes'], free)
        row['retainedFloorBytes'] = max(row['retainedFloorBytes'], floor)
        return row
    for path in (release, backup_directory):
        observe(path, 6 * 1024**3)
    for path, allocation in writes:
        row = observe(path)
        row['writes'][allocation] = allocations[allocation]
        row['additionalPeakBudgetBytes'] += allocations[allocation]
    # The small provisioning/drop-in/config/release-marker writes are separately
    # charged, even on devices separate from state or the payload. 2MiB per
    # destination is an explicit budget, not a measured artifact or disk quota.
    for label, path in (('systemdControlsMax', systemd), ('workerConfigurationMax', worker_config),
                        ('releaseMarkerMax', release)):
        row = observe(path)
        row['writes'][label] = 2097152
        row['additionalPeakBudgetBytes'] += 2097152
    if any(row['availableBytes'] - row['additionalPeakBudgetBytes'] < row['retainedFloorBytes'] for row in mounts.values()):
        raise ValueError('Insufficient capacity after completion peak; no cleanup or floor reduction authorized')
    return {'allocations': allocations, 'controlSourceBytes': inventory, 'mounts': list(mounts.values()),
            'controlTransportLimitBytes': 1048576,
            'runtimeAndJournalReserveIsBudgetNotHardLimit': True}


COMPLETION_CONTEXT = '/run/aistudy-completion'


def create_completion_claim(state, scope):
    """Publish our pre-identified inode exclusively; no pre-claim state record.

    The anonymous inode lives on state's filesystem (RuntimeDirectory may be
    tmpfs). The private runtime proof is durable BEFORE publishing the name.
    A crash on either side of link therefore cannot adopt an older claim.
    """
    state = Path(state)
    directory = safe_open(state, private=True, directory=True)
    context = safe_open(COMPLETION_CONTEXT, private=True, directory=True)
    fd = None
    try:
        fd = os.open('.', os.O_RDWR | os.O_TMPFILE, 0o600, dir_fd=directory)
        st = os.fstat(fd)
        proof = {'invocation': scope['invocation'], 'mainPid': scope['mainPid'],
                 'state': str(state), 'release': scope['release'], 'owner': scope['owner'],
                 'claimDevice': st.st_dev, 'claimInode': st.st_ino}
        marker = os.open('claim-origin.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=context)
        try:
            with os.fdopen(marker, 'wb') as out:
                out.write(json.dumps(proof).encode())
                out.flush()
                os.fsync(out.fileno())
        finally:
            os.fsync(context)
        # linkat via procfs follows OUR open descriptor, not an input pathname.
        # Unlike rename, link is exclusive and never replaces preexisting bytes.
        os.link('/proc/self/fd/' + str(fd), 'postmigration-completion-claimed',
                dst_dir_fd=directory, follow_symlinks=True)
        claim = {key: value for key, value in scope.items() if key != 'mainPid'}
        with os.fdopen(os.dup(fd), 'wb') as out:
            out.write(json.dumps(claim).encode())
            out.flush()
            os.fsync(out.fileno())
        os.fsync(directory)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(context)
        os.close(directory)


def completion_origin(state):
    context = safe_open(COMPLETION_CONTEXT, private=True, directory=True)
    os.close(context)
    proof = strict_json(read_trusted(Path(COMPLETION_CONTEXT) / 'claim-origin.json', private=True)[0])
    if (not isinstance(proof, dict) or set(proof) != {'invocation', 'mainPid', 'state', 'release', 'owner', 'claimDevice', 'claimInode'}
            or proof['state'] != state or not re.fullmatch(r'[1-9][0-9]*', str(proof['mainPid']))
            or any(not isinstance(proof[key], str) or not re.fullmatch(r'[0-9a-f]{32}', proof[key]) for key in ('owner', 'invocation'))):
        raise ValueError('Unknown completion creation origin')
    directory = safe_open(state, private=True, directory=True)
    try:
        # No content parse needed: an empty inode after link is still ours.
        fd = os.open('postmigration-completion-claimed', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            import stat
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != TRUSTED_UID or st.st_mode & 0o077 or st.st_nlink != 1
                    or [st.st_dev, st.st_ino] != [proof['claimDevice'], proof['claimInode']]):
                raise ValueError('Completion claim inode is not this invocation creation')
        finally:
            os.close(fd)
    finally:
        os.close(directory)
    return proof


def completion_claim(state):
    claim = strict_json(read_trusted(Path(state) / 'postmigration-completion-claimed', private=True)[0])
    if (set(claim) != {'scope', 'incident', 'release', 'automaticRetry', 'owner', 'invocation', 'capacity', 'payload', 'pgRestoreVersion'}
            or claim['scope'] != 'postmigration-independent-observation' or claim['automaticRetry'] is not False
            or claim['incident'] != str(Path(state) / 'releases' / COMPLETION_INCIDENT)
            or not isinstance(claim['release'], str) or os.path.normpath(claim['release']) != claim['release']
            or not Path(claim['release']).is_absolute() or not Path(claim['release']).name.startswith(COMPLETION_SHA + '-')
            or any(not isinstance(claim[key], str) or not re.fullmatch(r'[0-9a-f]{32}', claim[key]) for key in ('owner', 'invocation'))):
        raise ValueError('Unknown completion claim; manual scoped recovery required')
    return claim


COMPLETION_UNIT = 'aistudy-postmigration-completion.service'
COMPLETION_UNIT_PATH = '/run/systemd/system/' + COMPLETION_UNIT
COMPLETION_RETAINED_ENTRY = '/tmp/aistudy-entry.Pz65J76D'
COMPLETION_ADMISSION = '/run/aistudy-completion-admission'
POSTARCHIVE_ADMISSION = '/run/aistudy-completion-postarchive-admission'
POSTARCHIVE_UNIT_SHA = 'b215c973c4dcd06803403cb4294cfe05dbf3fced8a6b484c965b91079ac7934a'
COMPLETION_QUARANTINE = '/run/systemd/system/aistudy-completion-retained-205'
RELOAD_BOUND_NS = 60_000_000_000
# Covers three samples, archive/launch admission and the cold full payload check.
# Current scope/boot/fences are still rechecked; this is not permission to retry.
RELOAD_EVIDENCE_AGE_NS = 7_200_000_000_000
# Immutable reviewed 205 controls, NOT a new signed-controls producer. Required
# because the exceptional existing-unit path must not adopt arbitrary root code.
COMPLETION_205 = {
    'hermes-release.sh': '0039c3551063d23974ee4801231926277dbbb74c243cbc9d61d237bebe67d37c',
    'hermes-supervisor.mjs': '7966ccd061d8b8b16778c69d826c29f8f6e10cb96cf2e3e2ace6b12c65657619',
    'hermes-config-durability.mjs': '8f2e6046a714d9e4e26201c755fafe661864ee89f4cef85806a56b0e71fd25d0',
    'hermes-db.mjs': 'beb8809f8f59ada4b13174f955fc63d52a44638ac4607075bae413b6bc8100f8',
    'hermes-health.mjs': 'c61c6084a6addf1e4a81a25de6095a61500b375574b8f633adacbab350da49ce',
    'hermes-writer-control.mjs': 'df3cd9ea5bacce96a49e29fc5b8b8dcf5092e5e2b610a21f25b88b025df4976b',
    'hermes-trusted-loader.py': '9ee130b596c3938a1ec9161f7f89358e95a59c8f994980ae661ff09cb9cfa524',
    'hermes-writer-state.py': 'c3ecf5b7f9abfb312d4565edb71ba32062a03f408685610514dff3a773cff696',
    'hermes-writer-exec.py': '59a4f9cf0e9a90db9f2959517b58572873a9e7ce32b7902eed8af3fbc14d3b72',
    'hermes-peer-broker.py': 'e7448d4979ce89fdd0fec9b198148136be2fd47d3de27542af5530c3cce66092',
}


def completion_no_claim(state):
    for path in (Path(state) / 'postmigration-completion-claimed',
                 Path(COMPLETION_CONTEXT) / 'claim-origin.json'):
        if present(path):
            raise ValueError('Completion claim/origin present; no reentry')


def completion_controls():
    return {name: hashlib.sha256(read_trusted(trusted_loader.directory / name)[0]).hexdigest()
            for name in COMPLETION_ENTRY_FILES}


def completion_manager():
    keys = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'ExecMainPID',
            'ExecMainStartTimestampMonotonic', 'ExecMainExitTimestampMonotonic',
            'ActiveEnterTimestampMonotonic', 'InactiveExitTimestampMonotonic', 'ExecMainCode', 'ExecMainStatus', 'InvocationID',
            'NRestarts', 'Job', 'Result', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload')
    result = subprocess.run(['/usr/bin/systemctl', 'show', '--all', '--property=' + ','.join(keys), COMPLETION_UNIT],
                            check=True, capture_output=True, text=True, timeout=15)
    pairs = [line.split('=', 1) for line in result.stdout.strip().splitlines()]
    if len(pairs) != len(keys) or any(len(row) != 2 for row in pairs):
        raise ValueError('Incomplete completion manager observation')
    values = dict(pairs)
    if set(values) != set(keys):
        raise ValueError('Duplicate/unknown completion manager observation')
    return values


def completion_never_started(manager, not_found=False):
    expected = {'Id': COMPLETION_UNIT, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                'MainPID': '0', 'ControlPID': '0', 'ExecMainPID': '0', 'ExecMainStartTimestampMonotonic': '0',
                'ExecMainExitTimestampMonotonic': '0', 'ActiveEnterTimestampMonotonic': '0', 'InactiveExitTimestampMonotonic': '0',
                'ExecMainCode': '0', 'ExecMainStatus': '0', 'InvocationID': '', 'NRestarts': '0',
                'Result': 'success', 'FragmentPath': COMPLETION_UNIT_PATH, 'DropInPaths': '', 'NeedDaemonReload': 'no'}
    if not_found:
        expected.update(LoadState='not-found', FragmentPath='')
        if set(manager) != set(expected) | {'Job'}:
            raise ValueError('Archived manager observation inventory changed')
    if any(manager.get(k) != v for k, v in expected.items()) or manager.get('Job') not in ('', '0'):
        raise ValueError('Completion manager is not exact never-started unit')


def completion_private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(os.dup(fd), 'w') as output:
            json.dump(value, output, sort_keys=True)
            output.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(Path(path).parent)


def completion_scope(payload):
    args = payload['args']
    if (len(args) != 13 or args[0] != 'complete-postmigration' or args[9] != COMPLETION_SHA
            or args[11] != COMPLETION_ARCHIVE_SHA):
        raise ValueError('Wrong completion admission arguments')
    completion_no_claim(args[4])
    completion_incident_check(args[4], args[3], args[6], args[10], str(Path(args[1]) / '.env.production'), args[12], args[7])
    check_historical_manager(Path(args[4]), args[6])
    return args


def completion_sample_guard(payload, postarchive):
    args = completion_scope(payload)
    completion_retained_sources()
    if postarchive:
        old, _ = completion_archive(payload, args)
        if hashlib.sha256(old).hexdigest() != POSTARCHIVE_UNIT_SHA or present(COMPLETION_UNIT_PATH):
            raise ValueError('Postarchive original unit unconfirmed or live fragment present')
    else:
        if present(COMPLETION_QUARANTINE):
            raise ValueError('Retained archive already consumed; no repeated sampling')
        if read_trusted(COMPLETION_UNIT_PATH)[0] != payload['retainedUnit'].encode():
            raise ValueError('Retained unit differs before measured manager operations')
    manager = completion_manager()
    completion_never_started(manager, not_found=postarchive)
    return args, manager


def completion_reload_samples(payload, postarchive=False):
    # Separate explicit one-shot root; old evidence is never changed or adopted.
    args, _ = completion_sample_guard(payload, postarchive)
    directory = POSTARCHIVE_ADMISSION if postarchive else COMPLETION_ADMISSION
    os.mkdir(directory, 0o700)  # Existing attempt is not retry permission.
    sync_dir(Path(directory).parent)
    header = {'synthetic': False, 'deploymentReceipt': False, 'automaticRetry': False,
              'args': args, 'controls': completion_controls(),
              'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'boundNs': RELOAD_BOUND_NS}
    if postarchive:
        header['samplePhase'] = 'postarchive'
    completion_private_write(Path(directory) / 'scope.json', header)
    def observe():
        _, manager = completion_sample_guard(payload, postarchive)
        if postarchive and (completion_controls() != header['controls'] or
                Path('/proc/sys/kernel/random/boot_id').read_text().strip() != header['boot']):
            raise ValueError('Postarchive controls/boot changed during sampling')
        return manager
    for index in range(3):
        before = observe()
        started = time.monotonic_ns()
        completion_private_write(Path(directory) / ('sample-' + str(index) + '-started.json'),
                                 {**header, 'index': index, 'startNs': started, 'before': before})
        code, error = None, None
        try:
            result = subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=RELOAD_BOUND_NS / 1_000_000_000)
            code = result.returncode
        except (subprocess.TimeoutExpired, OSError) as failure:
            error = type(failure).__name__
        ended = time.monotonic_ns()
        try:
            after = observe()
        except Exception as failure:
            after = {'observationError': type(failure).__name__}
        record = {**header, 'index': index, 'startNs': started, 'endNs': ended, 'elapsedNs': ended - started,
                  'exit': code, 'error': error, 'before': before, 'after': after}
        completion_private_write(Path(directory) / ('sample-' + str(index) + '.json'), record)
        completion_never_started(after, not_found=postarchive)
        if code != 0 or error is not None or not 0 <= ended - started <= RELOAD_BOUND_NS // 2:
            raise ValueError('Reload admission failed; evidence/unit/claim retained')
    return {'samples': 3, 'boundNs': RELOAD_BOUND_NS, 'maximumNs': RELOAD_BOUND_NS // 2}


def completion_reload_admission(args, sample_phase=None):
    if sample_phase not in (None, 'postarchive'):
        raise ValueError('Unknown sample phase')
    postarchive = sample_phase == 'postarchive'
    if not postarchive and present(POSTARCHIVE_ADMISSION):
        raise ValueError('Postarchive evidence requires explicit postarchive entry')
    directory = POSTARCHIVE_ADMISSION if postarchive else COMPLETION_ADMISSION
    header = strict_json(read_trusted(Path(directory) / 'scope.json', private=True)[0])
    expected = {'synthetic': False, 'deploymentReceipt': False, 'automaticRetry': False,
                'args': args, 'controls': completion_controls(),
                'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'boundNs': RELOAD_BOUND_NS}
    if postarchive:
        expected['samplePhase'] = 'postarchive'
    if header != expected or postarchive and (any(type(header.get(k)) is not bool for k in ('synthetic', 'deploymentReceipt', 'automaticRetry'))
            or type(header.get('boundNs')) is not int):
        raise ValueError('Reload evidence controls/scope/boot changed')
    if postarchive and {p.name for p in Path(directory).iterdir()} != {'scope.json'} | {
            'sample-' + str(i) + suffix + '.json' for i in range(3) for suffix in ('-started', '')}:
        raise ValueError('Postarchive sample directory inventory changed')
    previous = None
    for index in range(3):
        row = strict_json(read_trusted(Path(directory) / ('sample-' + str(index) + '.json'), private=True)[0])
        if postarchive:
            if set(row) != set(header) | {'index', 'startNs', 'endNs', 'elapsedNs', 'exit', 'error', 'before', 'after'}:
                raise ValueError('Postarchive sample inventory changed')
            started = strict_json(read_trusted(Path(directory) / ('sample-' + str(index) + '-started.json'), private=True)[0])
            if (started != {**header, 'index': index, 'startNs': row.get('startNs'), 'before': row.get('before')}
                    or type(started.get('index')) is not int or type(started.get('startNs')) is not int):
                raise ValueError('Postarchive started evidence changed')
        if (any(row.get(k) != v for k, v in header.items()) or row.get('index') != index
                or postarchive and (type(row.get('index')) is not int or any(type(row.get(k)) is not bool for k in ('synthetic', 'deploymentReceipt', 'automaticRetry')) or type(row.get('boundNs')) is not int)
                or any(type(row.get(k)) is not int for k in ('startNs', 'endNs', 'elapsedNs', 'exit'))
                or row['exit'] != 0 or row.get('error') is not None
                or not 0 <= row['elapsedNs'] == row['endNs'] - row['startNs'] <= RELOAD_BOUND_NS // 2
                or not 0 <= time.monotonic_ns() - row['endNs'] <= RELOAD_EVIDENCE_AGE_NS
                or previous is not None and row['startNs'] < previous):
            raise ValueError('Three consecutive timely successful actual reload samples required')
        completion_never_started(row['before'], not_found=postarchive)
        completion_never_started(row['after'], not_found=postarchive)
        previous = row['endNs']


def completion_retained_sources():
    entry_fd = safe_open(COMPLETION_RETAINED_ENTRY, private=True, directory=True)
    os.close(entry_fd)
    if {p.name for p in Path(COMPLETION_RETAINED_ENTRY).iterdir()} != set(COMPLETION_205):
        raise ValueError('Retained entry inventory changed')
    for name, digest in COMPLETION_205.items():
        if hashlib.sha256(read_trusted(Path(COMPLETION_RETAINED_ENTRY) / name)[0]).hexdigest() != digest:
            raise ValueError('Retained entry not exact reviewed 205')


def completion_retained_archive(payload):
    args = completion_scope(payload)
    completion_reload_admission(args)
    before = completion_manager()
    completion_never_started(before)
    completion_retained_sources()
    unit, unit_identity = read_trusted(COMPLETION_UNIT_PATH)
    if unit != payload['retainedUnit'].encode():
        raise ValueError('Retained unit differs from exact incident arguments/205 controls')
    # Full incident/claim checks repeated directly before the archival mutation.
    completion_scope(payload)
    completion_never_started(completion_manager())
    if read_trusted(COMPLETION_UNIT_PATH) != (unit, unit_identity):
        raise ValueError('Retained unit changed before quarantine')
    os.mkdir(COMPLETION_QUARANTINE, 0o700)  # Same-filesystem exclusive destination.
    sync_dir(Path(COMPLETION_QUARANTINE).parent)
    completion_private_write(Path(COMPLETION_QUARANTINE) / 'manifest.json',
                             {'args': args, 'unitIdentity': unit_identity, 'unitSha256': hashlib.sha256(unit).hexdigest(),
                              'manager': before, 'entry': COMPLETION_RETAINED_ENTRY, 'controls205': COMPLETION_205})
    os.rename(COMPLETION_UNIT_PATH, Path(COMPLETION_QUARANTINE) / COMPLETION_UNIT)
    sync_dir(COMPLETION_QUARANTINE)
    sync_dir(Path(COMPLETION_UNIT_PATH).parent)
    archived_unit, archived_identity = read_trusted(Path(COMPLETION_QUARANTINE) / COMPLETION_UNIT)
    # Rename may change ctime (index 7), but not source dev/inode, mode, DAC,
    # size, mtime or single-link identity. Never certify a substituted inode.
    if archived_unit != unit or any(archived_identity[i] != unit_identity[i] for i in (0, 1, 2, 3, 4, 5, 6, 8)):
        raise ValueError('Retained unit changed during archive')
    completion_private_write(Path(COMPLETION_QUARANTINE) / 'archive-identity.json',
                             {'sourceIdentity': unit_identity, 'archiveIdentity': archived_identity,
                              'parentIdentity': identity(os.lstat(COMPLETION_QUARANTINE))})
    # No reload/start/unload here. Old manager state deliberately remains visible.
    return {'archived': True, 'automaticRetry': False}


def completion_archive(payload, args):
    archived = strict_json(read_trusted(Path(COMPLETION_QUARANTINE) / 'manifest.json', private=True)[0])
    old, archived_identity = read_trusted(Path(COMPLETION_QUARANTINE) / COMPLETION_UNIT)
    proof = strict_json(read_trusted(Path(COMPLETION_QUARANTINE) / 'archive-identity.json', private=True)[0])
    parent_fd = safe_open(COMPLETION_QUARANTINE, private=True, directory=True)
    try:
        parent_identity = identity(os.fstat(parent_fd))
    finally:
        os.close(parent_fd)
    # Adding the proof file changes parent mtime/ctime/size; bind its dev/inode
    # and DAC, while archived file identity remains exact in all fields.
    if (proof.get('sourceIdentity') != archived.get('unitIdentity')
            or proof.get('archiveIdentity') != archived_identity
            or any(proof['parentIdentity'][i] != parent_identity[i] for i in (0, 1, 2, 3, 4, 8))):
        raise ValueError('Retained archive inode/parent identity changed')
    if (old != payload['retainedUnit'].encode()
            or archived.get('args') != args or archived.get('controls205') != COMPLETION_205
            or archived.get('entry') != COMPLETION_RETAINED_ENTRY
            or archived.get('unitSha256') != hashlib.sha256(old).hexdigest()):
        raise ValueError('Retained unit archive unconfirmed')
    completion_never_started(archived['manager'])  # Historical prearchive loaded record, never relaxed.
    return old, archived_identity


def completion_launch_check(payload):
    args = completion_scope(payload)
    sample_phase = payload.get('samplePhase')
    if sample_phase is None:
        completion_reload_admission(args)
    else:
        completion_reload_admission(args, sample_phase)
    completion_retained_sources()
    old, _ = completion_archive(payload, args)
    if sample_phase == 'postarchive' and hashlib.sha256(old).hexdigest() != POSTARCHIVE_UNIT_SHA:
        raise ValueError('Postarchive original unit bytes changed')
    phase = payload['phase']
    if phase == 'absent':
        if present(COMPLETION_UNIT_PATH):
            raise ValueError('Existing completion unit is not replaceable')
        manager = completion_manager()
        if sample_phase == 'postarchive' or manager.get('LoadState') == 'not-found':
            # Explicit postarchive intake always requires strict not-found;
            # only the original route may observe the archived loaded record.
            # External reload may already have unloaded the archived fragment.
            # All prior archive/source/boot/scope checks still apply; no arbitrary
            # existing unit, stale fragment, invocation or start history qualifies.
            completion_never_started(manager, not_found=True)
        else:
            # Removing the fragment marks the retained never-started record stale.
            if manager.get('NeedDaemonReload') not in ('yes', 'no'):
                raise ValueError('Unknown retained manager reload state')
            completion_never_started({**manager, 'NeedDaemonReload': 'no'})
    elif phase == 'unloaded':
        if present(COMPLETION_UNIT_PATH):
            raise ValueError('Completion fragment appeared before install')
        completion_never_started(completion_manager(), not_found=True)
    elif phase in ('ready', 'claim'):
        if read_trusted(COMPLETION_UNIT_PATH)[0] != payload['unit'].encode():
            raise ValueError('New completion unit bytes changed')
        if phase == 'ready':
            completion_never_started(completion_manager())
        elif sample_phase == 'postarchive' and completion_manager().get('LoadState') != 'loaded':
            raise ValueError('Postarchive claim requires loaded new unit')
    else:
        raise ValueError('Unknown completion admission phase')
    return {'admitted': True}


def main():
    if sys.argv[1] in ('completion-reload-samples', 'completion-postarchive-reload-samples', 'completion-retained-archive', 'completion-launch-check'):
        operations = {'completion-reload-samples': completion_reload_samples,
                      'completion-postarchive-reload-samples': lambda payload: completion_reload_samples(payload, postarchive=True),
                      'completion-retained-archive': completion_retained_archive,
                      'completion-launch-check': completion_launch_check}
        print(json.dumps(operations[sys.argv[1]](json.load(sys.stdin))))
        return
    if sys.argv[1] == 'completion-create':
        create_completion_claim(sys.argv[2], json.load(sys.stdin))
        return
    if sys.argv[1] == 'completion-origin':
        print(json.dumps(completion_origin(sys.argv[2])))
        return
    if sys.argv[1] == 'completion-claim':
        print(json.dumps(completion_claim(sys.argv[2])))
        return
    if sys.argv[1] == 'completion-check':
        print(json.dumps(completion_check(*sys.argv[2:])))
        return
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
