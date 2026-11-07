"""Small, dependency-free CI path classifier and fail-closed required gates."""
import argparse
import json
import os
from pathlib import PurePosixPath
import subprocess


def git(*args):
    return subprocess.check_output(["git", *args])


def allowed_doc(path):
    p = PurePosixPath(path)
    # These documents are inputs to plan, tooling, or deployment contracts.
    # Whitespace-only checks must never replace their real consumer checks.
    if path.startswith(("docs/superpowers/", "docs/archive/superpowers/", "docs/quality/")) or path in {
        "docs/operations/ci.md", "docs/operations/cloud-deployment.md",
    }:
        return False
    return (
        path == "README.md"
        or (path.startswith("docs/") and p.suffix in {".md", ".txt"})
    ) and p.name not in {"AGENTS.md", "STATUS.md"}


def changed_paths(base, head):
    # NUL records preserve spaces/newlines. Both sides of renames must qualify.
    fields = git("diff", "--name-status", "-z", "--find-renames", base, head).decode().split("\0")
    paths = []
    i = 0
    while i < len(fields) - 1:
        status = fields[i]
        count = 2 if status.startswith(("R", "C")) else 1
        if status[0] not in "AMDRC":
            return []  # Type changes and unknown statuses must run full CI.
        paths.extend(fields[i + 1:i + 1 + count])
        i += 1 + count
    return paths


def docs_only(base, head):
    paths = changed_paths(base, head)
    if not paths or not all(allowed_doc(p) for p in paths):
        return False
    # A newly added/deleted symlink can otherwise masquerade as a .md file.
    for revision in (base, head):
        entries = git("ls-tree", "-rz", revision, "--", *paths).split(b"\0")
        if any(entry and not entry.startswith(b"100644 ") for entry in entries):
            return False
    return True


def require_success(needs, name):
    if needs.get(name, {}).get("result") != "success":
        raise ValueError(f"Required job {name} did not succeed")


def check_gate(needs, workers):
    require_success(needs, "changes")
    mode = needs["changes"].get("outputs", {}).get("docs_only")
    if mode == "true":
        require_success(needs, "docs")
    elif mode == "false":
        for name in workers:
            require_success(needs, name)
    else:
        raise ValueError("Missing or invalid classification output")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["classify", "docs", "gate"])
    parser.add_argument("workers", nargs="*")
    args = parser.parse_args()
    if args.mode == "gate":
        if not args.workers:
            raise ValueError("No required workers configured")
        check_gate(json.loads(os.environ["CI_NEEDS"]), args.workers)
        print("Required CI gate passed")
        return
    base, head = os.environ.get("DIFF_BASE", ""), os.environ.get("DIFF_HEAD", "")
    if args.mode == "classify":
        # Manual runs / initial pushes intentionally take the full path. Invalid
        # nonempty SHAs fail the job rather than silently authorizing a fast path.
        result = bool(base and head and set(base) != {"0"}) and docs_only(base, head)
        line = f"docs_only={str(result).lower()}"
        print(line)
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write(line + "\n")
    else:
        if not docs_only(base, head):
            raise ValueError("Light check contains a non-allowlisted change or empty diff")
        subprocess.run(["git", "diff", "--check", base, head], check=True)
        print("Documentation allowlist and diff whitespace checks passed")


if __name__ == "__main__":
    main()
