#!/usr/bin/env bash
# Guard tests for coop-setup-org.sh's routing vocabulary/charset checks.
#
# These guards exist to fail loudly when the routing config drifts from Osprey's
# vocabularies. A guard that cannot go red is not a guard, so every case below that
# expects rejection IS a positive control: it proves the check discriminates rather
# than merely passing. Run: bash divine/test-coop-setup-guards.sh
set -uo pipefail
cd "$(dirname "$0")/.."
awk '/^CANONICAL_REASONS=/,/^done$/' divine/coop-setup-org.sh > /tmp/_coop_guard.sh
fails=0

check() { # name expect_rc rows...
  local name="$1" expect="$2"; shift 2
  { printf 'CATROUTES=(\n'; for r in "$@"; do printf '  "%s"\n' "$r"; done; printf ')\n'
    cat /tmp/_coop_guard.sh; } > /tmp/_coop_case.sh
  local out rc
  out=$(bash /tmp/_coop_case.sh 2>&1); rc=$?
  if [ "$rc" -eq "$expect" ]; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s (rc=%s want=%s) %s\n' "$name" "$rc" "$expect" "$out"; fails=$((fails+1))
  fi
}

echo "accepted:"
check "the real shipped routing config" 0 \
  "report_reason|CSAM|csam" "report_reason|Child Safety|child_safety" \
  "report_reason|Age Review|underage_user" "report_reason|Sexual Content|nudity" \
  "report_reason|Violence & Extremism|violence" "report_reason|Harassment, Threats & Safety|harassment" \
  "label_value|CSAM|csam,sexual_minors" "label_value|Sexual Content|nudity,sexual,explicit,pornography" \
  "label_value|Violence & Extremism|violence,gore,graphic-violence"
check "hyphenated label token (the old [a-z_] charset rejected these)" 0 \
  "label_value|Violence & Extremism|graphic-violence,ai-generated"

echo "rejected (positive controls -- each MUST go red):"
check "typo in a label token" 1 "label_value|CSAM|sexual_minor"
check "report_reason route using a label-only token" 1 "report_reason|CSAM|sexual_minors"
check "label route using a report_reason-only token" 1 "label_value|CSAM|child_safety"
check "regex metacharacter in a token" 1 "label_value|CSAM|csam.*"
check "hyphen in a report_reason token (charset is per-field)" 1 "report_reason|CSAM|ai-generated"
check "unknown CONTENT_FIELD" 1 "media_sha256|CSAM|csam"
check "empty field" 1 "|CSAM|csam"

if [ "$fails" -ne 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all guard tests passed"
