#!/usr/bin/env python3
"""Provision the systemd worker without changing the legacy application env."""

import argparse
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import subprocess
import sys
import tempfile

USER = "aistudy-worker"
ENV_PATH_KEYS = {"PARSER_PYTHON", "HF_HOME", "PARSER_OCR_MODEL_DIR"}


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)


def absolute(value):
    path = Path(value)
    if not path.is_absolute() or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("deployment paths must be absolute and contain no control characters")
    return path


def read_paths(config):
    """Read only supported path values; never execute/source a production env."""
    values = {}
    for line in config.read_text().splitlines():
        key, separator, raw = line.strip().removeprefix("export ").partition("=")
        key = key.strip()
        if separator and key in ENV_PATH_KEYS:
            parts = shlex.split(raw, comments=True)
            if len(parts) > 1:
                raise ValueError(f"{key} must contain a single quoted or unquoted path")
            if parts and parts[0]:
                values[key] = str(absolute(parts[0]))
    return values


def atomic_write(path, value, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(value)
        os.chmod(temporary, mode)
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def snapshot(args):
    before = args.state_dir / "worker-before"
    if before.is_symlink():
        raise ValueError("worker snapshot directory must not be a symlink")
    if before.exists():
        if not (before / "ready").is_file():
            raise ValueError("worker snapshot is incomplete; retain it for inspection and use a fresh state directory")
        manifest = json.loads((before / "manifest.json").read_text())
        expected = {"aistudy-worker.service": str(args.systemd_dir / "aistudy-worker.service"),
                    "worker-runtime.env": str(args.config_dir / "worker-runtime.env")}
        if manifest["targets"] != expected:
            raise ValueError("existing snapshot belongs to different target paths")
        return before
    before.mkdir(parents=True, mode=0o700)
    os.chmod(before, 0o700)
    targets = {"aistudy-worker.service": args.systemd_dir / "aistudy-worker.service",
               "worker-runtime.env": args.config_dir / "worker-runtime.env"}
    for name, target in targets.items():
        if target.exists() or target.is_symlink():
            shutil.copy2(target, before / name, follow_symlinks=False)
        else:
            (before / f"{name}.absent").touch(mode=0o600)
    states = {}
    for state in ("active", "enabled"):
        states[state] = subprocess.run(["systemctl", f"is-{state}", "--quiet", "aistudy-worker.service"], check=False).returncode == 0
    (before / "manifest.json").write_text(json.dumps({"targets": {name: str(target) for name, target in targets.items()}, "service": states}))
    (before / "ready").touch(mode=0o600)
    return before


def restore(args):
    before = args.state_dir / "worker-before"
    if not (before / "ready").is_file():
        raise ValueError("worker snapshot is missing or incomplete")
    manifest = json.loads((before / "manifest.json").read_text())
    expected = {"aistudy-worker.service": args.systemd_dir / "aistudy-worker.service",
                "worker-runtime.env": args.config_dir / "worker-runtime.env"}
    if manifest["targets"] != {name: str(target) for name, target in expected.items()}:
        raise ValueError("snapshot target paths differ; pass the original --systemd-dir and --config-dir")
    for name, target in expected.items():
        saved = before / name
        if saved.exists() or saved.is_symlink():
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.restore-{os.getpid()}")
            shutil.copy2(saved, temporary, follow_symlinks=False)
            os.replace(temporary, target)
        elif (before / f"{name}.absent").is_file():
            target.unlink(missing_ok=True)
        else:
            raise ValueError(f"snapshot entry is missing: {name}")
    run(["systemctl", "daemon-reload"])


def ensure_identity():
    try:
        group = grp.getgrnam(USER)
    except KeyError:
        run(["groupadd", "--system", USER])
        group = grp.getgrnam(USER)
    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        run(["useradd", "--system", "--gid", USER, "--home-dir", "/var/cache/aistudy-worker",
             "--shell", "/usr/sbin/nologin", "--no-create-home", USER])
        account = pwd.getpwnam(USER)
    if account.pw_uid == 0 or group.gr_gid == 0 or account.pw_gid != group.gr_gid:
        raise ValueError("existing worker identity must be non-root and use its dedicated primary group")
    if account.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin", "/bin/false"):
        raise ValueError("existing worker identity must not have an interactive login shell")
    return account.pw_uid, group.gr_gid


def read_only_tree(root, writable_roots=()):
    """Never follow artifact symlinks into legacy envs, caches or interpreters."""
    resolved_root = root.resolve()

    def check_link(path):
        target = path.resolve()
        if not target.is_relative_to(resolved_root) and any(target.is_relative_to(directory) for directory in writable_roots):
            raise ValueError("read-only runtime code links into a writable cache or temporary directory")

    for directory, names, files in os.walk(root, followlinks=False):
        for name in names:
            path = Path(directory) / name
            if path.is_symlink():
                check_link(path)
        names[:] = [name for name in names if name not in (".local", ".tmp") and not (Path(directory) / name).is_symlink()]
        parent = Path(directory)
        os.chown(parent, 0, 0)
        os.chmod(parent, 0o755)
        for name in files:
            path = parent / name
            if path.is_symlink():
                check_link(path)
                continue
            mode = path.stat().st_mode
            os.chown(path, 0, 0)
            private = name.startswith(".env") and not name.endswith(".example")
            os.chmod(path, 0o600 if private else 0o755 if mode & 0o111 else 0o644)


def prepare_cache(cache, legacy_cache, identity):
    # Never recursively chown/copy into a cache already writable by the worker:
    # a compromised parser could replace a child with a symlink to /etc.
    if cache.exists() or cache.is_symlink():
        if cache.is_symlink() or not cache.is_dir() or cache.stat().st_uid != identity[0]:
            raise ValueError("existing worker cache must be a real directory owned by the dedicated worker")
        return
    cache.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".aistudy-worker-cache-", dir=cache.parent))
    handed_over = False
    try:
        target = staging / "hf-home"
        if legacy_cache.is_symlink():
            raise ValueError("legacy HF_HOME must be a real directory; inspect symlinks before migrating it")
        if legacy_cache.is_dir():
            def model_files_only(directory, names):
                # These are Hugging Face login credentials, not model assets.
                return set(names) & {"token", "stored_tokens"} if Path(directory) == legacy_cache else set()
            shutil.copytree(legacy_cache, target, symlinks=True, ignore=model_files_only)
        else:
            target.mkdir()
        for directory, names, files in os.walk(staging, followlinks=False):
            parent = Path(directory)
            # The outer directory remains root:0700 while descendants become
            # worker-owned, so an existing worker cannot swap entries under
            # the root process's subsequent validation/chmod operations.
            if parent != staging:
                os.chown(parent, *identity, follow_symlinks=False)
            os.chmod(parent, 0o700)
            for name in names + files:
                child = parent / name
                if child.is_symlink() and not child.resolve(strict=True).is_relative_to(target):
                    raise ValueError("legacy model cache has a symlink outside the copied HF_HOME")
                os.chown(child, *identity, follow_symlinks=False)
                if not child.is_symlink() and child.is_file():
                    os.chmod(child, 0o600)
        os.chown(staging, *identity, follow_symlinks=False)
        handed_over = True
        os.rename(staging, cache)
    finally:
        # Never recurse again after the worker can enter. A failed final rename
        # retains that staging directory for inspection instead of trusting it.
        if not handed_over and staging.exists():
            shutil.rmtree(staging)


def quoted(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def verify_effective_unit(args):
    keys = ("User", "Group", "ProtectSystem", "PrivateTmp", "WorkingDirectory", "ReadWritePaths", "EnvironmentFiles")
    result = run(["systemctl", "show", "aistudy-worker.service", *[f"--property={key}" for key in keys]], capture_output=True, text=True)
    actual = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    expected = {"User": USER, "Group": USER, "ProtectSystem": "strict", "PrivateTmp": "yes",
                "WorkingDirectory": str(args.app_dir), "ReadWritePaths": str(args.cache_dir)}
    if any(actual.get(key) != value for key, value in expected.items()):
        raise ValueError("effective worker isolation differs from the managed unit; inspect existing systemd drop-ins")
    last_env = str(args.config_dir / "worker-runtime.env") + " (ignore_errors=no)"
    if not actual.get("EnvironmentFiles", "").endswith(last_env):
        raise ValueError("worker runtime env must be the last effective EnvironmentFile; inspect systemd drop-ins")


def configure(args):
    config = args.config_file or args.legacy_app_dir / ".env.production"
    if not config.is_file():
        raise ValueError("production config file is missing")
    os.chown(config, 0, 0)
    os.chmod(config, 0o600)
    release = (args.release_dir or args.app_dir).resolve(strict=True)
    paths = read_paths(config)
    python = args.parser_python or Path(paths.get("PARSER_PYTHON", str(args.legacy_app_dir / ".local/docling-venv/bin/python")))
    if not python.is_file() or not os.access(python, os.X_OK):
        raise ValueError("parser Python is missing or not executable; pass --parser-python")
    if any(python.resolve().is_relative_to(Path(home)) for home in ("/root", "/home")):
        raise ValueError("parser interpreter must be outside /root and /home for ProtectHome=true")
    parser_cwd = release / "services/parser"
    if not (parser_cwd / "opening_parser/__main__.py").is_file():
        raise ValueError("release parser package is missing")
    snapshot(args)
    identity = ensure_identity()
    writable_roots = (args.cache_dir.resolve(), Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))
    read_only_tree(release, writable_roots)
    for parent in python.parents:
        if (parent / "pyvenv.cfg").is_file():
            read_only_tree(parent, writable_roots)
            break
    cache = args.cache_dir
    if cache.is_relative_to(release):
        raise ValueError("worker cache must be outside the read-only release")
    prepare_cache(cache, Path(paths.get("HF_HOME", str(args.legacy_app_dir / ".local/hf-home"))), identity)
    runtime = {"HOME": str(cache), "HF_HOME": str(cache / "hf-home"), "HF_HUB_CACHE": str(cache / "hf-home/hub"),
               "HUGGINGFACE_HUB_CACHE": str(cache / "hf-home/hub"), "TRANSFORMERS_CACHE": str(cache / "hf-home/hub"),
               "XDG_CACHE_HOME": str(cache), "TORCH_HOME": str(cache / "torch"), "TMPDIR": "/tmp",
               "WORKER_READINESS_FILE": str(cache / "worker-ready.json"),
               "PARSER_PREFLIGHT_CACHE_FILE": str(cache / "parser-preflight-success.json"),
               "PARSER_TEMP_DIR": "/tmp/opening-parser", "PARSER_PYTHON": str(python),
               "PARSER_CWD": str(args.app_dir / "services/parser"), "HF_HUB_OFFLINE": "1"}
    check_env = {**runtime, "PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1"}
    if "PARSER_OCR_MODEL_DIR" in paths:
        check_env["PARSER_OCR_MODEL_DIR"] = paths["PARSER_OCR_MODEL_DIR"]
    # cwd is the prepared release, while the installed runtime points to the
    # stable current symlink that the deployment caller switches afterwards.
    run(["runuser", "-u", USER, "--", "env", "-i", *[f"{key}={value}" for key, value in check_env.items()],
         str(python), "-m", "opening_parser", "--check"], cwd=parser_cwd, timeout=90,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    template = args.unit_file.read_text()
    # Single-path directives retain surrounding quotes literally; path lists
    # such as ReadWritePaths use systemd's quoted-word parser instead.
    replacements = {"WorkingDirectory=": str(args.app_dir), "ReadWritePaths=": quoted(cache)}
    lines = []
    for line in template.splitlines():
        if line == "EnvironmentFile=/opt/aistudy/.env.production":
            line = "EnvironmentFile=" + str(config).replace("%", "%%")
        elif line == "EnvironmentFile=/etc/aistudy/worker-runtime.env":
            line = "EnvironmentFile=" + str(args.config_dir / "worker-runtime.env").replace("%", "%%")
        for prefix, value in replacements.items():
            if line.startswith(prefix):
                line = prefix + value.replace("%", "%%")
        lines.append(line)
    unit = "\n".join(lines) + "\n"
    for required in (f"User={USER}", f"Group={USER}", "ProtectSystem=strict", "PrivateTmp=true"):
        if required not in lines:
            raise ValueError(f"worker unit is missing required isolation: {required}")
    with tempfile.TemporaryDirectory(prefix="worker-unit-check-", dir=args.state_dir) as directory:
        candidate = Path(directory) / "aistudy-worker.service"
        candidate.write_text(unit)
        run(["systemd-analyze", "verify", str(candidate)])
    try:
        atomic_write(args.systemd_dir / "aistudy-worker.service", unit, 0o644)
        atomic_write(args.config_dir / "worker-runtime.env", "".join(f"{key}={quoted(value)}\n" for key, value in runtime.items()), 0o600)
        run(["systemctl", "daemon-reload"])
        verify_effective_unit(args)
    except BaseException:
        try:
            restore(args)
        except Exception as error:
            print(f"worker configuration restore failed: {type(error).__name__}", file=sys.stderr)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--snapshot", action="store_true")
    mode.add_argument("--restore", action="store_true")
    for name, default in (("app-dir", "/opt/aistudy"), ("legacy-app-dir", "/opt/aistudy"),
                          ("state-dir", "/var/lib/aistudy-deploy"), ("config-dir", "/etc/aistudy"),
                          ("systemd-dir", "/etc/systemd/system"), ("cache-dir", "/var/cache/aistudy-worker")):
        parser.add_argument(f"--{name}", type=absolute, default=absolute(default))
    for name in ("release-dir", "config-file", "parser-python"):
        parser.add_argument(f"--{name}", type=absolute)
    parser.add_argument("--unit-file", type=absolute, default=Path(__file__).with_name("aistudy-worker.service"))
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise PermissionError("worker provisioning requires root")
    args.config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.config_dir.is_symlink():
        raise ValueError("worker config directory must not be a symlink")
    os.chown(args.config_dir, 0, 0)
    os.chmod(args.config_dir, args.config_dir.stat().st_mode & 0o755)
    args.systemd_dir.mkdir(parents=True, exist_ok=True)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.state_dir.is_symlink():
        raise ValueError("worker state directory must not be a symlink")
    os.chown(args.state_dir, 0, 0)
    os.chmod(args.state_dir, 0o700)
    with (args.config_dir / ".worker-provision.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.snapshot:
            snapshot(args)
        elif args.restore:
            restore(args)
        else:
            configure(args)


if __name__ == "__main__":
    main()
