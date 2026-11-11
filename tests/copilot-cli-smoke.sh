#!/usr/bin/env bash
# Install this marketplace into a scratch Copilot CLI home and check, in the real interactive
# CLI, that the m365 extension loads, that its commands answer, and that doing so used no
# model at all (zero requests and zero AI credits in the CLI's own usage report).
#
#   tests/copilot-cli-smoke.sh            uses `copilot` from PATH
#   COPILOT_BIN=/path/to/copilot tests/copilot-cli-smoke.sh
#
# Needs tmux. Runs without signing in: nothing here may need the model.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
copilot=${COPILOT_BIN:-copilot}
work=$(mktemp -d)
export COPILOT_HOME="$work/home"
# The CLI must not find a credential: a signed-in run could hide a model call.
unset GH_TOKEN GITHUB_TOKEN COPILOT_GITHUB_TOKEN
sock="m365-smoke-$$"

tm() { tmux -L "$sock" "$@"; }
cleanup() {
  tm kill-server 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

screen() { tm capture-pane -t cli -p -S -400 2>/dev/null || true; }
fail() {
  echo "FAIL: $*"
  echo "----- screen -----"
  screen
  echo "----- logs -----"
  tail -n 40 "$COPILOT_HOME"/logs/*.log 2>/dev/null || true
  exit 1
}
# wait_for <fixed text> <seconds>
wait_for() {
  local end=$((SECONDS + $2))
  until screen | grep -qF -- "$1"; do
    ((SECONDS < end)) || fail "timed out after $2 s waiting for: $1"
    sleep 1
  done
}
# Type a command, then press Enter separately: an Enter that arrives with the text can be
# taken by the input box's completion list instead of submitting.
run() {
  tm send-keys -t cli -l -- "$1"
  sleep 1
  tm send-keys -t cli Enter
}

echo "== $("$copilot" --version | head -n 1)"

echo "== install from the marketplace"
"$copilot" plugin marketplace add "$repo"
"$copilot" plugin install m365@nox-marketplace
"$copilot" plugin list | grep -F 'm365@nox-marketplace' || fail 'm365 is not in the plugin list'

mkdir -p "$work/project"
git -C "$work/project" init -q

echo "== start the interactive CLI"
tm new-session -d -s cli -x 200 -y 100 \
  "cd '$work/project' && '$copilot' --experimental --no-auto-update --usage-output-file '$work/usage.json'; sleep 600"

# A new folder asks for trust before extensions load. The first choice trusts it for this run.
end=$((SECONDS + 90))
until screen | grep -qF 'Do you trust'; do
  ((SECONDS < end)) || fail 'the folder trust prompt did not appear'
  sleep 1
done
tm send-keys -t cli Enter

echo "== wait for the extension"
end=$((SECONDS + 90))
until grep -lF 'm365/extension.mjs' "$COPILOT_HOME"/logs/*.log 2>/dev/null | xargs -r grep -qF '=== ready ==='; do
  ((SECONDS < end)) || fail 'the m365 extension did not report ready'
  sleep 1
done

echo "== /m365 --help"
run '/m365 --help'
# Only the usage text has this sentence; the completion list also shows "/m365-raw".
wait_for '素の質問だけを送るときは' 30

echo "== /m365 --profiles"
run '/m365 --profiles'
wait_for 'm365.json が見つかりません' 30

echo "== /m365-raw --dry"
run '/m365-raw --dry smoke-test-question'
wait_for '送信する文面' 30

echo "== exit and read the usage report"
run '/exit'
end=$((SECONDS + 60))
until [[ -s "$work/usage.json" ]]; do
  ((SECONDS < end)) || fail 'no usage report was written'
  sleep 1
done
node -e '
  const u = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  const used = { requests: u.totalUserRequests, premiumRequests: u.totalPremiumRequestCost, nanoAiu: u.totalNanoAiu }
  console.log("usage:", JSON.stringify(used))
  if (Object.values(used).some((v) => v !== 0)) { console.error("FAIL: the commands used the model"); process.exit(1) }
' "$work/usage.json"

echo "OK"
