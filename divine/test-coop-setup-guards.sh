#!/usr/bin/env bash
# Guard tests for coop-setup-org.sh's routing vocabulary/charset checks.
#
# These guards exist to fail loudly when the routing config drifts from Osprey's
# vocabularies. A guard that cannot go red is not a guard, so every case below that
# expects rejection IS a positive control: it proves the check discriminates rather
# than merely passing. Run: bash divine/test-coop-setup-guards.sh
#
# TWO extractions, deliberately:
#   REAL_BLOCK  starts at CATROUTES, so it carries the SHIPPED routing array and the
#               guard validates the config we actually provision. An earlier version of
#               this file started below CATROUTES and re-declared the array by hand --
#               which meant poisoning the real CSAM route left these tests green. The
#               config is the artifact worth testing; a hand-copy of it is not.
#   GUARD_ONLY  starts at CANONICAL_REASONS, for driving synthetic rows.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=divine/coop-setup-org.sh
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT   # not fixed /tmp paths: concurrent runs
                                                  # clobbered each other, and a shared host
                                                  # let another user pre-create them.
awk '/^CATROUTES=/,/^done$/'          "$SRC" > "$WORK/real.sh"
awk '/^CANONICAL_REASONS=/,/^done$/'  "$SRC" > "$WORK/guard.sh"

# Refuse to run at all if either extraction missed -- a silently-empty range is exactly
# the vacuous pass these tests exist to prevent.
grep -q '^CATROUTES=(' "$WORK/real.sh"        || { echo "FATAL: CATROUTES not captured"; exit 1; }
grep -q 'CANONICAL_LABEL_VALUES=' "$WORK/real.sh" || { echo "FATAL: vocab not captured"; exit 1; }
grep -q 'for tok in' "$WORK/guard.sh"         || { echo "FATAL: guard loop not captured"; exit 1; }
fails=0

# Production runs under `set -euo pipefail`; so must the harness, or the guard is
# exercised under different semantics than it ships with (an unset-var abort was
# invisible here until it was added).
run() { ( set -euo pipefail; bash "$1" ) 2>&1; }

check() { # name expect_rc rows...
  local name="$1" expect="$2"; shift 2
  { printf 'CATROUTES=(\n'; for r in "$@"; do printf '  "%s"\n' "$r"; done; printf ')\n'
    cat "$WORK/guard.sh"; } > "$WORK/case.sh"
  local out rc
  out=$(run "$WORK/case.sh") && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then printf '  ok    %s\n' "$name"
  else printf '  FAIL  %s (rc=%s want=%s) %s\n' "$name" "$rc" "$expect" "$out"; fails=$((fails+1)); fi
}

echo "the SHIPPED config (not a copy of it):"
out=$(run "$WORK/real.sh") && rc=0 || rc=$?
if [ "${rc:-0}" -eq 0 ]; then echo "  ok    divine/coop-setup-org.sh CATROUTES passes its own guard"
else echo "  FAIL  shipped CATROUTES rejected by its own guard: $out"; fails=$((fails+1)); fi

echo "accepted:"
check "hyphenated label token (the old [a-z_] charset rejected these)" 0 \
  "label_value|Violence & Extremism|graphic-violence,ai-generated"
check "queue name containing a space, comma and ampersand" 0 \
  "report_reason|Harassment, Threats & Safety|harassment"

echo "rejected (positive controls -- each MUST go red):"
check "typo in a label token" 1 "label_value|CSAM|sexual_minor"
check "report_reason route using a label-only token" 1 "report_reason|CSAM|sexual_minors"
check "label route using a report_reason-only token" 1 "label_value|CSAM|child_safety"
check "regex metacharacter in a token" 1 "label_value|CSAM|csam.*"
check "hyphen in a report_reason token (charset is per-field)" 1 "report_reason|CSAM|ai-generated"
check "unknown CONTENT_FIELD" 1 "media_sha256|CSAM|csam"
check "empty field" 1 "|CSAM|csam"
# The provisioner splits with python .split(","), which keeps empty fields; bash drops a
# trailing one. Without these, "csam," shipped ^$ on the CSAM route -- and ^$ matches an
# empty label_value.
check "trailing comma (would ship ^\$ into CSAM)" 1 "label_value|CSAM|csam,"
check "leading comma" 1 "label_value|CSAM|,csam"
check "double comma" 1 "label_value|CSAM|csam,,sexual_minors"
check "empty token list" 1 "label_value|CSAM|"

if [ "$fails" -ne 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all guard tests passed"
