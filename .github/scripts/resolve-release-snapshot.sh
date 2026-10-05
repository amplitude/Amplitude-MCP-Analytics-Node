#!/usr/bin/env bash
# Print the commit a squashed release pull request should tag.
#
# The squash is publishable only when it landed on the same main commit the
# release pull request was opened against, and its tree matches that release
# commit. A later commit on main, or a merge commit, is rejected.
#
# Usage: resolve-release-snapshot.sh <release-head> <squash-sha>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: resolve-release-snapshot.sh <release-head> <squash-sha>" >&2
  exit 2
fi

RELEASE_HEAD=$(git rev-parse --verify "${1}^{commit}")
SQUASH_SHA=$(git rev-parse --verify "${2}^{commit}")

mapfile -t RELEASE_PARENTS < <(git rev-parse "${RELEASE_HEAD}^@")
if [[ ${#RELEASE_PARENTS[@]} -ne 1 ]]; then
  echo "Release commit ${RELEASE_HEAD} has ${#RELEASE_PARENTS[@]} parents." >&2
  echo "Re-run the Release workflow instead of using Update branch." >&2
  exit 1
fi
BASE="${RELEASE_PARENTS[0]}"

UNEXPECTED=""
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    package.json | CHANGELOG.md | .release-please-manifest.json) ;;
    *) UNEXPECTED+="${file}"$'\n' ;;
  esac
done < <(git diff --name-only "$BASE" "$RELEASE_HEAD")
if [[ -n "$UNEXPECTED" ]]; then
  echo "Release commit changes files other than the version, changelog, and manifest:" >&2
  printf '%s' "$UNEXPECTED" >&2
  exit 1
fi

mapfile -t SQUASH_PARENTS < <(git rev-parse "${SQUASH_SHA}^@")
if [[ ${#SQUASH_PARENTS[@]} -eq 1 && "${SQUASH_PARENTS[0]}" == "$BASE" ]] &&
  git diff --quiet "$RELEASE_HEAD" "$SQUASH_SHA"; then
  echo "$SQUASH_SHA"
  exit 0
fi

echo "This squash includes commits that landed after the release pull request was opened." >&2
echo "Re-run the Release workflow so those commits are in the changelog, then squash-merge that pull request." >&2
exit 1
