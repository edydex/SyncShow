#!/bin/bash
# generate_release_notes.sh
# Generates release notes from commit messages containing 'rel-note:' between last and current release

set -eo pipefail

# Get the latest stable tag (skip prereleases), falling back to the root commit
LAST_TAG=$(git describe --tags --abbrev=0 \
  --exclude='*-alpha*' --exclude='*-beta*' \
  --exclude='*-rc*' --exclude='*-dev*' \
  HEAD^ 2>/dev/null) || LAST_TAG=$(git rev-list --max-parents=0 HEAD)

# Get commit messages between last tag (non-inclusive) and HEAD (inclusive)
# grep || true prevents set -e from exiting when no rel-note lines are found
RELEASE_NOTES=$(git log "${LAST_TAG}..HEAD" --pretty=%B | grep 'rel-note:' | sed -E 's/^.*rel-note:[[:space:]]*(.*)$/- \1/') || true

# Output release notes
if [ -n "$RELEASE_NOTES" ]; then
  echo "$RELEASE_NOTES"
else
  echo "No release notes found."
fi
