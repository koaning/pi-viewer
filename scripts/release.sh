#!/usr/bin/env bash
# Publishes a build to the `release` branch, which `pi install git:github.com/koaning/pi-viewer@release` installs.
# pi doesn't build git packages, so the branch carries dist/. It holds one commit, replaced on every release, so the
# built files never pile up in the history; main stays source only.
set -euo pipefail
cd "$(dirname "$0")/.."

# What the release is built from should be a commit, so it can be named.
if [ -n "$(git status --porcelain)" ]; then
  echo "release: commit or stash your changes first" >&2
  exit 1
fi

url=${RELEASE_URL:-$(git remote get-url origin)}
source=$(git rev-parse --short HEAD)
version=$(node -p 'require("./package.json").version')

bun run typecheck
bun test
bun run build

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cp -R package.json README.md dist "$out"/
git -C "$out" init -q -b release
git -C "$out" add -A
git -C "$out" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
  commit -q -m "pi-viewer $version, built from $source"
git -C "$out" push -q --force "$url" release
echo "release: pi-viewer $version ($source) is on the release branch"

# A tag and a GitHub release per version: the tag keeps the build around once the branch moves on, so it can be pinned
# with `@v<version>`. A version that was released before keeps its tag; bump package.json for a new one.
tag="v$version"
if git ls-remote --exit-code --tags "$url" "refs/tags/$tag" >/dev/null; then
  echo "release: $tag already exists, so it stays as it was; bump the version in package.json to tag this one" >&2
else
  git -C "$out" tag "$tag"
  git -C "$out" push -q "$url" "$tag"
  # Only for the real repository, not a RELEASE_URL test.
  if [ -z "${RELEASE_URL:-}" ]; then
    gh release create "$tag" --verify-tag --title "pi-viewer $version" \
      --notes "Built from $source. Install with \`pi install git:github.com/koaning/pi-viewer@release\`, or pin this version with \`@$tag\`."
  fi
fi
echo "  pi install git:github.com/koaning/pi-viewer@release"
