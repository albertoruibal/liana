#!/usr/bin/env bash
# Create a demo repo with an in-progress conflicted rebase and a submodule.
# Usage: ./scripts/make-conflict-fixture.sh [dir]
set -euo pipefail

DIR="${1:-test-repo-conflict}"
SRC="${DIR}-submodule-src"

if [[ -e "$DIR" ]]; then
  echo "refusing to overwrite existing '$DIR'" >&2
  exit 1
fi

# A tiny standalone repository to use as a local submodule.
git init -q -b main "$SRC"
git -C "$SRC" config user.name "Demo User"
git -C "$SRC" config user.email "demo@example.com"
echo "library v1" > "$SRC/lib.txt"
git -C "$SRC" add lib.txt
git -C "$SRC" commit -q -m "library initial"
SRC_ABS="$(cd "$SRC" && pwd)"

mkdir -p "$DIR"
cd "$DIR"
git init -q -b main
git config user.name "Demo User"
git config user.email "demo@example.com"
git config commit.gpgsign false

c() { # c <file> <content> <message>
  echo "$2" > "$1"
  git add "$1"
  git commit -q -m "$3"
}

c app.js "export const version = 1;" "initial commit"

# Local submodule (file protocol must be explicitly allowed for local clones).
git -c protocol.file.allow=always submodule add -q "$SRC_ABS" lib
git commit -q -m "add lib submodule"

# Build a rebase that will conflict: feature and main both edit app.js.
git checkout -q -b feature
c app.js "export const version = 2; // feature" "feature: bump version"

git checkout -q main
c app.js "export const version = 3; // main" "main: bump version"

git checkout -q feature
if ! git rebase main >/dev/null 2>&1; then
  echo "rebase left a conflict as intended"
fi

echo "fixture repo ready: $DIR"
git status --short
git submodule status --recursive
