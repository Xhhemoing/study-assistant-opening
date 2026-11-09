#!/usr/bin/python3
"""Fixed root-trusted entry, started with -I -S -B, not a candidate import.

Only this stdlib bootstrap executes before source DAC checks. Root/the installer
already owns this entry and is trusted, not contained by this protocol. Siblings
are compiled from descriptor-verified bytes, never imported from cwd or pycache.
TRUSTED_UID is an object-only test seam; production always starts with UID 0.
"""
import os
from pathlib import Path
import stat
import sys
import types

sys.dont_write_bytecode = True
TRUSTED_UID = 0
SOURCES = ('hermes-trusted-loader.py', 'hermes-writer-exec.py',
           'hermes-peer-broker.py', 'hermes-writer-state.py')


def identity(st):
    return [str(value) for value in (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
                                    st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_nlink)]


def safe_open(path, private=False, directory=False, *, uid=0):
    """Absolute descriptor walk; root sticky ancestor is not a writable parent."""
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
            sticky = (index < len(parts) - (1 if directory else 2) and stat.S_ISDIR(st.st_mode)
                      and st.st_uid == 0 and st.st_mode & stat.S_ISVTX)
            trusted_owner = st.st_uid == uid if final else st.st_uid in (0, uid)
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


def read_trusted(path, private=False, sync=False, *, uid=0):
    fd = safe_open(path, private, uid=uid)
    try:
        before = identity(os.fstat(fd))
        with os.fdopen(os.dup(fd), 'rb') as source:
            data = source.read()
        if sync:
            os.fsync(fd)
        # A second descriptor walk rechecks ancestor DAC and path identity.
        check = safe_open(path, private, uid=uid)
        try:
            if before != identity(os.fstat(fd)) or before != identity(os.fstat(check)):
                raise ValueError('Trusted file changed')
        finally:
            os.close(check)
        return data, before
    finally:
        os.close(fd)


class SourceLoader:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.modules = {}
        self.sources = None

    def verify(self):
        # Validate the COMPLETE installed inventory before any sibling executes.
        # Repeated reads detect replacement during inventory capture; memory
        # caches never authorize a newly changed on-disk source generation.
        sources = {name: read_trusted(self.directory / name, uid=TRUSTED_UID) for name in SOURCES}
        for name, expected in sources.items():
            if read_trusted(self.directory / name, uid=TRUSTED_UID) != expected:
                raise ValueError('Installed sources changed')
        if self.sources is not None and sources != self.sources:
            raise ValueError('Installed source identity changed')
        self.sources = sources

    def load(self, name):
        if name not in SOURCES or name == SOURCES[0]:
            raise ValueError('Unknown trusted sibling')
        self.verify()
        if name not in self.modules:
            path = str(self.directory / name)
            module = types.ModuleType(name.removesuffix('.py').replace('-', '_'))
            module.__file__ = path
            module.trusted_loader = self
            module.bootstrap = types.SimpleNamespace(identity=identity, safe_open=safe_open,
                                                     read_trusted=read_trusted)
            self.modules[name] = module
            try:
                exec(compile(self.sources[name][0], path, 'exec', dont_inherit=True), module.__dict__)
            except BaseException:
                del self.modules[name]
                raise
        return self.modules[name]


def main():
    modes = {'exec': 'hermes-writer-exec.py', 'state': 'hermes-writer-state.py',
             'broker': 'hermes-peer-broker.py'}
    mode = sys.argv[1]
    loader = SourceLoader(Path(__file__).parent)
    module = loader.load(modes[mode])
    sys.argv = [module.__file__, *sys.argv[2:]]
    module.main()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Trusted writer source/admission refused', file=sys.stderr)
        sys.exit(1)
