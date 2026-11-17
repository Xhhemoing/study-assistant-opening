#!/usr/bin/python3
"""Reviewed entry transport only; no state, manager or provider operations."""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

FILES = ('hermes-release.sh', 'hermes-supervisor.mjs', 'hermes-config-durability.mjs',
         'hermes-db.mjs', 'hermes-health.mjs', 'hermes-writer-control.mjs',
         'hermes-trusted-loader.py', 'hermes-writer-state.py', 'hermes-writer-exec.py',
         'hermes-peer-broker.py')


def check_files(directory, *, uid=None):
    for name in FILES:
        st = (Path(directory) / name).lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise ValueError('Entry files must be regular and single-link')
        if uid is not None and (st.st_uid != uid or st.st_mode & 0o022):
            raise PermissionError('Untrusted entry file owner/mode')


def pack(directory):
    # Checkout ownership/umask is not the installed root trust boundary. Strip
    # only group/other write; preserve bytes and required executable/read bits.
    check_files(directory)
    subprocess.run(['tar', '--owner=0', '--group=0', '--numeric-owner', '--mode=go-w',
                    '-czf', '-', '-C', os.fspath(directory), '--', *FILES], check=True)


def extract(stream, directory, *, uid=0, git_controls=False):
    # Production always uses root. uid is an object-only unprivileged test seam.
    directory = Path(directory)
    st = directory.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
        raise PermissionError('Entry directory must be private and trusted')
    if any(directory.iterdir()):
        raise ValueError('Entry directory must be empty')
    # SSH stdin is a non-seekable pipe. Stage anonymously inside the private
    # entry so full-inventory validation can precede every extracted file.
    with tempfile.TemporaryFile(dir=directory) as staged:
        if git_controls:
            remaining = 1048576
            while True:
                chunk = stream.read(min(65536, remaining + 1))
                if not chunk:
                    break
                remaining -= len(chunk)
                if remaining < 0:
                    raise ValueError('Completion transport exceeds 1 MiB')
                staged.write(chunk)
        else:
            shutil.copyfileobj(stream, staged)
        staged.seek(0)
        _extract(staged, directory, git_controls=git_controls)
    check_files(directory, uid=uid)


def _extract(stream, directory, *, git_controls=False):
    with tarfile.open(fileobj=stream, mode='r:gz') as archive:
        if git_controls:
            members, total = [], 0
            for member in archive:
                total += member.size
                if len(members) >= len(FILES) + 2 or member.size < 0 or total > 1048576:
                    raise ValueError('Completion extracted controls exceed bounds')
                members.append(member)
        else:
            members = archive.getmembers()
        if git_controls:
            parents = [m for m in members if m.name in ('infra', 'infra/deploy')]
            if (len(parents) != 2 or any(not m.isdir() or m.uid != 0 or m.gid != 0 or m.mode & 0o7022 for m in parents)
                    or len(members) != len(FILES) + 2 or sum(m.size for m in members) > 1048576):
                raise ValueError('Unexpected Git control inventory')
            members = [m for m in members if m not in parents]
            for member in members:
                if member.name not in {'infra/deploy/' + name for name in FILES}:
                    raise ValueError('Unexpected Git control path')
                member.name = member.name.removeprefix('infra/deploy/')
        if len(members) != len(FILES) or {m.name for m in members} != set(FILES):
            raise ValueError('Unexpected entry inventory')
        # Validate the whole transport before writing ANY file. Never apply tar
        # paths, links, ownership, directories or special types via extractall.
        for member in members:
            if (not member.isreg() or member.linkname or member.uid != 0 or member.gid != 0
                    or member.mode & 0o022):
                raise ValueError('Untrusted entry archive type/metadata')
        for member in members:
            fd = os.open(directory / member.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as destination, archive.extractfile(member) as source:
                shutil.copyfileobj(source, destination)
                os.fchmod(destination.fileno(), member.mode)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('pack', 'extract', 'extract-git'):
        raise ValueError('Invalid entry transport arguments')
    if sys.argv[1] == 'pack':
        pack(sys.argv[2])
    else:
        extract(sys.stdin.buffer, sys.argv[2], git_controls=sys.argv[1] == 'extract-git')


if __name__ == '__main__':
    main()
