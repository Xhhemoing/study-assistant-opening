#!/usr/bin/env bash
# Build only in an isolated clean checkout; never load production environment files.
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: build-release-artifact.sh <new-output-directory>' >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
cd -- "$root"
[[ -z "$(git status --porcelain)" ]] || { echo 'A clean checkout is required.' >&2; exit 1; }
sha=$(git rev-parse HEAD)
[[ "$(git branch --show-current)" == feat/opening-release ]] || { echo 'Build the release mainline only.' >&2; exit 1; }
remote=study-assistant-opening
if ! git remote get-url "$remote" >/dev/null 2>&1; then remote=origin; fi
url=$(git remote get-url "$remote")
[[ "$url" == https://github.com/Xhhemoing/study-assistant-opening.git || "$url" == https://github.com/Xhhemoing/study-assistant-opening || "$url" == git@github.com:Xhhemoing/study-assistant-opening.git ]] || { echo 'Formal repository required.' >&2; exit 1; }
[[ "$(git ls-remote "$remote" refs/heads/feat/opening-release | cut -f1)" == "$sha" ]] || { echo 'Release mainline tip changed.' >&2; exit 1; }
# git archive, not the builder's working directory: no ignored env, DB or private files.
# Dependency/build steps run in this disposable source tree, without caller secrets.
output=$(realpath -m -- "$1")
[[ ! -e "$output" ]] || { echo 'Output directory must not exist.' >&2; exit 1; }
mkdir -m 700 -- "$output"
build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT
git -c core.autocrlf=false -c core.eol=lf archive "$sha" | tar -x -C "$build"
cd -- "$build"
env -i PATH="$PATH" HOME="$build" CI=true AISTUDY_COMMIT="$sha" \
  bash -c 'set -euo pipefail; npm ci --no-audit --no-fund; npm run build -w @aistudy/worker; npm run build -w @aistudy/web'
node "$root/infra/deploy/verify-release-artifact.mjs" pack "$build" "$output/release.tar.gz" "$sha" "$root"
[[ "$(git -C "$root" ls-remote "$remote" refs/heads/feat/opening-release | cut -f1)" == "$sha" ]] || { echo 'Release mainline tip changed during build.' >&2; exit 1; }
sha256sum "$output/release.tar.gz"
# A local build is NOT deployable merely because it has a manifest. Transfer it
# through the trusted CI attestation workflow before using the managed artifact path.
