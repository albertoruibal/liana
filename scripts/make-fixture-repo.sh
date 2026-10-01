#!/usr/bin/env bash
# Create a demo repo with a richly branched history: main plus feature/login
# and feature/search (both merged), an unmerged hotfix, a release/1.0 branch,
# tags, a local origin remote, and a stash. Usage: ./scripts/make-fixture-repo.sh [dir]
set -euo pipefail

DIR="${1:-test-repo}"

if [[ -e "$DIR" ]]; then
  echo "refusing to overwrite existing '$DIR'" >&2
  exit 1
fi

mkdir -p "$DIR"
cd "$DIR"
git init -q -b main

git config user.name "Demo User"
git config user.email "demo@example.com"
git config commit.gpgsign false

c() { # c <file> <message>
  echo "$2" > "$1"
  git add "$1"
  git commit -q -m "$2"
}

# --- main trunk ---
c readme.txt "initial commit"
c app.js "add app skeleton"
c styles.css "configure base stylesheet"
c router.js "wire up router"
git tag v0.9

# --- feature/login, merged into main ---
git checkout -q -b feature/login
c login.js "add login form"
c login.js "add password field"
c login.js "validate credentials"
c login.js "show inline errors"
c login.js "add remember-me checkbox"

git checkout -q main
c app.js "tweak app settings"
git merge -q --no-ff feature/login -m "merge feature/login"

# --- feature/search, merged into main ---
git checkout -q -b feature/search
c search.js "add search box"
c search.js "add search results list"
c search.js "debounce queries"
c search.js "highlight matching rows"

git checkout -q main
c app.js "polish UI"
git merge -q --no-ff feature/search -m "merge feature/search"

# A local origin so the graph shows a remote-tracking ref (no network used).
REMOTE_DIR="$(mktemp -d)/origin.git"
git init -q --bare "$REMOTE_DIR"
git remote add origin "$REMOTE_DIR"
git push -q -u origin main

# --- release/1.0, forked from main and left unmerged ---
git checkout -q -b release/1.0
c CHANGELOG.md "write changelog"
c package.json "bump version to 1.0.0"

# --- hotfix, forked from main and left unmerged ---
git checkout -q main
git checkout -q -b hotfix
c hotfix.js "reproduce crash on empty input"
c hotfix.js "guard against empty input"
c hotfix.js "add regression test"

git checkout -q main
c app.js "add release notes"
git tag v1.0

# leave a stash entry so the graph demo shows a stash node
echo "unfinished" >> app.js
git stash push -q -m "draft settings tweak"

# leave HEAD on main with a clean tree
git checkout -q main

echo "fixture repo ready: $DIR"
git log --oneline --graph --all --decorate | head -40
git stash list
