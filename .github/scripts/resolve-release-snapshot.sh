#!/usr/bin/env bash
# Print the commit a release should tag and publish.
#
# The release pull request is opened against a specific main commit. That
# commit, plus the release-please version bump on top of it, is the snapshot.
# A later merge to main must not become part of the tagged tree.
#
# Usage: resolve-release-snapshot.sh <release-head> <merge-sha>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: resolve-release-snapshot.sh <release-head> <merge-sha>" >&2
  exit 2
fi

RELEASE_HEAD=$(git rev-parse --verify "${1}^{commit}")
MERGE_SHA=$(git rev-parse --verify "${2}^{commit}")

mapfile -t RELEASE_PARENTS < <(git rev-parse "${RELEASE_HEAD}^@")
if [[ ${#RELEASE_PARENTS[@]} -ne 1 ]]; then
  echo "Release commit ${RELEASE_HEAD} has ${#RELEASE_PARENTS[@]} parents." >&2
  echo "Re-run the Release workflow instead of updating the release branch." >&2
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

# Merge commits keep the release head as a parent, including when main moved
# after the pull request opened. Tag that head, not the merge result.
if git merge-base --is-ancestor "$RELEASE_HEAD" "$MERGE_SHA"; then
  echo "$RELEASE_HEAD"
  exit 0
fi

# A squash onto the same base has the same tree and is the commit on main.
mapfile -t MERGE_PARENTS < <(git rev-parse "${MERGE_SHA}^@")
if [[ ${#MERGE_PARENTS[@]} -eq 1 && "${MERGE_PARENTS[0]}" == "$BASE" ]] &&
  git diff --quiet "$RELEASE_HEAD" "$MERGE_SHA"; then
  echo "$MERGE_SHA"
  exit 0
fi

echo "This merge includes commits that landed after the release pull request was opened." >&2
echo "Re-run the Release workflow so those commits are in the changelog, then merge that pull request with a merge commit." >&2
exit 1
