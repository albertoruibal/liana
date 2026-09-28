#!/usr/bin/env bash
# Create a demo repo with a GitKraken-like history: main + feature branch,
# merge, cherry-pick-able commit on a side branch. Usage: ./scripts/make-fixture-repo.sh [dir]
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

c readme.txt "initial commit"
c app.js "add app skeleton"

git checkout -q -b feature/login
c login.js "add login form"
c login.js "validate credentials"

git checkout -q main
c app.js "tweak app settings"

git checkout -q feature/login
c login.js "add remember-me checkbox"

git checkout -q main
git merge -q --no-ff feature/login -m "merge feature/login"

git checkout -q -b hotfix
c hotfix.js "critical fix on hotfix branch"

git checkout -q main
c app.js "polish UI"

# leave HEAD on main with a clean tree
git checkout -q main

echo "fixture repo ready: $DIR"
git log --oneline --graph --all | head -20