#!/usr/bin/env bash
# Mirrors skills/run-test-plan into the EZCORP skills repo and opens (or refreshes) a PR there.
# Runs from .github/workflows/sync-ezcorp.yml; also works locally with a GH_TOKEN that can push
# branches to the target repo.
set -euo pipefail

: "${GH_TOKEN:?Set GH_TOKEN (secret EZCORP_SKILLS_TOKEN) to a token with write access to the target repo}"
TARGET_REPO="${TARGET_REPO:-ezcorp-appdev/ezcorp.skills-repo}"
TARGET_DIR="skills/appdev/qa/run-test-plan"
BRANCH="${SYNC_BRANCH:-qa/run-test-plan-sync}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$SRC/.claude-plugin/plugin.json').version")"
TODAY="$(date -u +%F)"
SRC_SHA="$(git -C "$SRC" rev-parse --short HEAD)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone --quiet --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${TARGET_REPO}.git" "$work"
cd "$work"

# The first PR registers the skill (marketplace.json, REGISTRY.md, README table). Until it merges,
# a sync PR would be flagged as an unregistered skill, so wait for it.
if ! grep -qF '"./qa/run-test-plan"' .claude-plugin/marketplace.json; then
  echo "::warning::run-test-plan is not registered in ${TARGET_REPO} yet. Merge the first PR, then rerun."
  exit 0
fi

git checkout --quiet -B "$BRANCH"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$SRC/skills/run-test-plan/." "$TARGET_DIR/"
sed -i -E \
  -e "s/^\| Version \|.*$/| Version | ${VERSION} |/" \
  -e "s/^\| Last updated \|.*$/| Last updated | ${TODAY} |/" \
  "$TARGET_DIR/README.md"

git add -A "$TARGET_DIR"
if git diff --cached --quiet; then
  echo "Already in sync with ${TARGET_REPO}@main."
  exit 0
fi

login="$(gh api user --jq .login)"
id="$(gh api user --jq .id)"
git -c user.name="$login" -c user.email="${id}+${login}@users.noreply.github.com" \
  commit --quiet -m "feat(skills/appdev/qa/run-test-plan): sync to v${VERSION} (qa-runner ${SRC_SHA})"
git push --quiet --force origin "$BRANCH"

title="feat(skills/appdev/qa/run-test-plan): sync to v${VERSION} from qa-runner"
body="$work/.pr-body.md"
{
  echo "## 📲 What"
  echo "Updates the existing \`run-test-plan\` skill to v${VERSION}. Synced automatically from [jorgeebits/qa-runner@${SRC_SHA}](https://github.com/jorgeebits/qa-runner/commit/${SRC_SHA})."
  echo
  echo "## 🤔 Why"
  echo "qa-runner is the source of truth for this skill; this PR mirrors its latest changes:"
  echo
  git -C "$SRC" log -15 --format='- %h %s' -- skills/run-test-plan .claude-plugin/plugin.json
  echo
  echo "## 👀 Evidence"
  echo "Tested in qa-runner before release (QA / non-prod environments only). Author to add evidence for behavior changes."
  echo
  echo "## ✅ Checklist"
  echo "- [x] \`SKILL.md\` frontmatter valid (\`name\` + \`description\`); \`README.md\` present"
  echo "- [x] Version set/bumped (\`Version\` + \`Last updated\` in the skill README)"
  echo "- [x] No out-of-scope file changes (only \`${TARGET_DIR}/\`)"
  echo "- [ ] Tested in a **QA / non-prod** environment (see Evidence)"
  echo
  echo "## 🔒 Security & data handling"
  echo "- [ ] I reviewed the diff for **secrets/credentials** and confirm the content is acceptable at this repo's access level."
  echo "- [ ] **Customer PII** uses synthetic / placeholder data — no real identifiers."
  echo "- [ ] Credentials, where unavoidable, are the team's shared **non-prod** config."
  echo
  echo "## 🔗 Related"
  echo "https://github.com/jorgeebits/qa-runner"
} > "$body"

pr="$(gh pr list --repo "$TARGET_REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty')"
if [ -n "$pr" ]; then
  gh pr edit "$pr" --repo "$TARGET_REPO" --title "$title" --body-file "$body"
  echo "Updated PR #${pr}"
else
  gh pr create --repo "$TARGET_REPO" --base main --head "$BRANCH" --title "$title" --body-file "$body"
fi
