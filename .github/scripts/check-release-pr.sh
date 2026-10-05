#!/usr/bin/env bash
# Fail when a release pull request is not the snapshot release-please just
# generated from current main.
#
# Usage: check-release-pr.sh <base-sha> <body-file>
# HEAD is the release pull request head.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: check-release-pr.sh <base-sha> <body-file>" >&2
  exit 2
fi

BASE_SHA="$1"
if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "base sha must be a 40-character commit sha" >&2
  exit 2
fi
BODY=$(cat "$2")

mapfile -t PARENTS < <(git rev-parse "HEAD^@")
if [[ ${#PARENTS[@]} -ne 1 ]]; then
  echo "::error::This release pull request was updated with Update branch. Re-run the Release workflow so the changelog includes the latest commits on main." >&2
  exit 1
fi

if [[ "${PARENTS[0]}" != "$BASE_SHA" ]]; then
  echo "::error::This release pull request is behind main (${PARENTS[0]} is not ${BASE_SHA}). Re-run the Release workflow. Do not use Update branch." >&2
  exit 1
fi

RECORDED=$(printf '%s\n' "$BODY" | sed -n 's/^<!-- release-base: \([0-9a-f]\{40\}\) -->$/\1/p' | head -1)
if [[ -z "$RECORDED" ]]; then
  echo "::error::This release pull request is missing its release-base marker. Re-run the Release workflow." >&2
  exit 1
fi

if [[ "$RECORDED" != "$BASE_SHA" ]]; then
  echo "::error::This release was generated from ${RECORDED}, not current main ${BASE_SHA}. Re-run the Release workflow. Do not use Update branch." >&2
  exit 1
fi

echo "Release pull request matches ${BASE_SHA}."
