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
#               guard validates the config we actually provision. It stops at the first
#               provisioning loop, not the guard loop, so a route added below the guard's
#               one execution point is still visible to the routing-table assertion.
#               The config is the artifact worth testing; a hand-copy of it is not.
#   GUARD_ONLY  starts at CANONICAL_REASONS, for driving synthetic rows.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=divine/coop-setup-org.sh
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT   # not fixed /tmp paths: concurrent runs
                                                  # clobbered each other, and a shared host
                                                  # let another user pre-create them.
awk '/^CATROUTES=/,/^echo "==> Ensuring category routing rules"/ { if ($0 !~ /^echo "==> Ensuring category routing rules"/) print }' "$SRC" > "$WORK/real.sh"
awk '/^CANONICAL_REASONS=/,/^done$/' "$SRC" > "$WORK/guard.sh"
awk '/^print_done_banner\(\)/{flag=1} flag{print} flag && /^}/{exit}' "$SRC" > "$WORK/banner.sh"
awk '/^record_adapter_probe_status\(\)/{flag=1} flag{print} flag && /^}/{exit}' "$SRC" > "$WORK/probe.sh"
awk '
  /^  ACCOUNT_ACTIONS=/{flag=1}
  /^  if \[ "\${COOP_ACCOUNT_ACTIONS:-0}" = "1" \]; then/{flag=0}
  flag{sub(/^  /, ""); print}
' "$SRC" > "$WORK/action_scope.sh"

# Refuse to run at all if either extraction missed -- a silently-empty range is exactly
# the vacuous pass these tests exist to prevent.
grep -q '^CATROUTES=(' "$WORK/real.sh"        || { echo "FATAL: CATROUTES not captured"; exit 1; }
grep -q 'CANONICAL_LABEL_VALUES=' "$WORK/real.sh" || { echo "FATAL: vocab not captured"; exit 1; }
grep -q 'for tok in' "$WORK/guard.sh"         || { echo "FATAL: guard loop not captured"; exit 1; }
grep -q 'for tok in' "$WORK/real.sh"         || { echo "FATAL: shipped-config range does not reach the guard loop"; exit 1; }
grep -q '^print_done_banner' "$WORK/banner.sh" || { echo "FATAL: final banner function not captured"; exit 1; }
grep -q '^record_adapter_probe_status' "$WORK/probe.sh" || { echo "FATAL: probe function not captured"; exit 1; }
grep -q '^action_type_ids_json' "$WORK/action_scope.sh" || { echo "FATAL: action scope function not captured"; exit 1; }
fails=0

extract_fields() { # src dest -- capture the shipped field declaration from a source file
  awk '/^CT_FIELDS=/{f=1} f{print} f && /^# --- end field declaration/{exit}' "$1" > "$2"
  # Returns non-zero rather than exiting: the positive controls deliberately feed this
  # broken input, and an exit here would take the whole suite with it.
  grep -q '^profile_fields_json()' "$2" || { echo "field generator not captured from $1"; return 1; }
  grep -q 'end field declaration'  "$2" || { echo "field declaration range never terminated in $1"; return 1; }
}

# Production runs under `set -euo pipefail`, so the CHILD must too. Options are
# per-process: `( set -euo pipefail; bash f )` gives them to the subshell and NOT to the
# bash it spawns, which is how an unset-variable abort stayed invisible here even after
# this comment first claimed it was caught. Pass the flags to the child directly.
run() { bash -euo pipefail "$1" 2>&1; }

check() { # name expect_rc rows...
  local name="$1" expect="$2"; shift 2
  { printf 'CATROUTES=(\n'; for r in "$@"; do printf '  "%s"\n' "$r"; done; printf ')\n'
    cat "$WORK/guard.sh"; } > "$WORK/case.sh"
  local out rc
  out=$(run "$WORK/case.sh") && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then printf '  ok    %s\n' "$name"
  else printf '  FAIL  %s (rc=%s want=%s) %s\n' "$name" "$rc" "$expect" "$out"; fails=$((fails+1)); fi
}

check_script() { # name expect_rc script
  local name="$1" expect="$2" script="$3"
  local out rc
  out=$(run "$script") && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then printf '  ok    %s\n' "$name"
  else printf '  FAIL  %s (rc=%s want=%s) %s\n' "$name" "$rc" "$expect" "$out"; fails=$((fails+1)); fi
}

echo "the SHIPPED config (not a copy of it):"
out=$(run "$WORK/real.sh") && rc=0 || rc=$?
if [ "${rc:-0}" -eq 0 ]; then echo "  ok    divine/coop-setup-org.sh CATROUTES passes its own guard"
else echo "  FAIL  shipped CATROUTES rejected by its own guard: $out"; fails=$((fails+1)); fi

# The guard is a vocabulary/charset check, so a test that only runs the guard can only
# ever catch a misspelled token. It cannot see a token DROPPED, a row DELETED, or a route
# REDIRECTED to a different queue -- all three of which are lexically perfect and all three
# of which silently mis-route CSAM. Pin the whole (field, queue, tokens) triple set, so
# changing where CSAM goes requires changing this list too, deliberately.
echo "the shipped routing table matches the expected triples:"
EXPECTED=$(cat <<'TRIPLES'
label_value|CSAM|csam,sexual_minors
label_value|Sexual Content|nudity,sexual,explicit,pornography
label_value|Violence & Extremism|violence,gore,graphic-violence
report_reason|Age Review|underage_user
report_reason|CSAM|csam
report_reason|Child Safety|child_safety
report_reason|Harassment, Threats & Safety|harassment
report_reason|Sexual Content|nudity
report_reason|Violence & Extremism|violence
TRIPLES
)
EXPECTED=$(printf '%s\n' "$EXPECTED" | LC_ALL=C sort)   # order-insensitive: add routes anywhere
# The guard runs ONCE, at a fixed point. A row appended below it is unvalidated by the
# guard but still changes what the provisioning loop sees, so the dump below must include
# everything up to the first route use. Also require exactly one direct assignment to keep
# the routing table declaration easy to audit.
_assigns=$(grep -cE '^[[:space:]]*CATROUTES\+?=' "$SRC" || true)
if [ "$_assigns" -ne 1 ]; then
  echo "  FAIL  CATROUTES is assigned/appended $_assigns times; expected exactly 1."
  echo "        A row added after the guard's single execution point ships unvalidated."
  grep -nE '^[[:space:]]*CATROUTES\+?=' "$SRC" | sed 's/^/        /'
  fails=$((fails+1))
fi
# Derive ACTUAL from BASH, not from text. A sed that matched only `  "row"` was blind to
# five shapes bash accepts -- a trailing comment, tab/4-space/no indent, single quotes --
# so an ADDED route vanished from the comparison and the suite reported all-clear while
# bash held one more route than it printed. Text extraction fails safe on deletions (a
# missing row still diffs) but fails OPEN on additions, which is the class that hides a
# duplicate `label_value -> CSAM` row that would later overwrite the real CSAM rule.
# Running the shipped block and printing the array is by construction what the script
# iterates, so no shape can hide -- and it catches indexed assignment and eval too.
{ cat "$WORK/real.sh"; echo 'printf "%s\n" "${CATROUTES[@]}"'; } > "$WORK/dump.sh"
ACTUAL=$(bash -euo pipefail "$WORK/dump.sh" 2>/dev/null | LC_ALL=C sort)
if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "  ok    $(printf '%s\n' "$ACTUAL" | grep -c .) routes, each to its intended queue"
else
  echo "  FAIL  shipped routing table differs from the expected triples:"
  diff <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$ACTUAL") | sed 's/^/        /' || true
  echo "        If this change is intended, update EXPECTED in this file in the same commit."
  fails=$((fails+1))
fi

echo "the shipped priority list covers every category route:"
EXPECTED_PRIORITY=$(printf '%s\n' "$ACTUAL" | awk -F'|' '{ print $1 " -> " $2 }')
ACTUAL_PRIORITY=$(python3 - "$SRC" <<'PY'
import ast
import re
import sys

src = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"priority = \[(.*?)\]", src, re.S)
if not match:
    raise SystemExit("priority list not found")
priority = ast.literal_eval("[" + match.group(1) + "]")
print("\n".join(sorted(priority)))
PY
)
if [ "$ACTUAL_PRIORITY" = "$EXPECTED_PRIORITY" ]; then
  echo "  ok    priority names match CATROUTES"
else
  echo "  FAIL  priority list differs from CATROUTES-derived route names:"
  diff <(printf '%s\n' "$EXPECTED_PRIORITY") <(printf '%s\n' "$ACTUAL_PRIORITY") | sed 's/^/        /' || true
  echo "        Every CATROUTES row needs a priority entry so new category routes cannot fall into the unordered bucket."
  fails=$((fails+1))
fi

echo "the nostr_user (profile-only report) routing is present and ordered:"
# Pins the whole (queue, token) set of the nostr_user report_reason routes, plus the
# ordering invariant (CSAM first, the nostr_user match-all default LAST), plus that the
# rule NAMES are type-prefixed so they cannot collide org-wide with the nostr_event
# routes of the same field/queue. Derived from BASH like CATROUTES, so an added or
# dropped row cannot hide.
{ awk '/^USER_CATROUTES=\(/,/^\)/' "$SRC"; echo 'printf "%s\n" "${USER_CATROUTES[@]}"'; } > "$WORK/user_routes.sh"
USER_ROWS=$(bash -euo pipefail "$WORK/user_routes.sh" 2>/dev/null)
USER_ACTUAL=$(printf '%s\n' "$USER_ROWS" | LC_ALL=C sort)
USER_EXPECTED=$(printf '%s\n' \
  'CSAM|csam' \
  'Child Safety|child_safety' \
  'Sexual Content|nudity' \
  'Violence & Extremism|violence' \
  'Harassment, Threats & Safety|harassment' | LC_ALL=C sort)
if [ "$USER_ACTUAL" = "$USER_EXPECTED" ]; then
  echo "  ok    $(printf '%s\n' "$USER_ACTUAL" | grep -c .) nostr_user report_reason routes, each to its intended queue"
else
  echo "  FAIL  shipped USER_CATROUTES differs from the expected (queue, token) set:"
  diff <(printf '%s\n' "$USER_EXPECTED") <(printf '%s\n' "$USER_ACTUAL") | sed 's/^/        /' || true
  fails=$((fails+1))
fi
# underage_user must NOT be routed for nostr_user either (age review is relay-manager's).
if printf '%s\n' "$USER_ACTUAL" | grep -q 'underage_user'; then
  echo "  FAIL  nostr_user routes must not include underage_user (age review is relay-manager's)"
  fails=$((fails+1))
else
  echo "  ok    nostr_user routing excludes underage_user"
fi
# user_priority: CSAM first, nostr_user General Review last.
USER_PRIORITY=$(python3 - "$SRC" <<'PY'
import ast, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"user_priority = \[(.*?)\]", src, re.S)
if not m:
    raise SystemExit("user_priority list not found")
print("\n".join(ast.literal_eval("[" + m.group(1) + "]")))
PY
)
FIRST=$(printf '%s\n' "$USER_PRIORITY" | head -1)
LAST=$(printf '%s\n' "$USER_PRIORITY" | tail -1)
if [ "$FIRST" = "nostr_user: report_reason -> CSAM" ] && [ "$LAST" = "nostr_user -> General Review" ]; then
  echo "  ok    nostr_user order is CSAM first, General Review last"
else
  echo "  FAIL  nostr_user ordering wrong (first='$FIRST' last='$LAST')"
  echo "        CSAM must be first (sticky, NCMEC-bound) and the match-all default last (first-match-wins)."
  fails=$((fails+1))
fi
# Name collision: every nostr_user route name must be type-prefixed so it is distinct
# org-wide from the nostr_event route of the same field/queue.
if printf '%s\n' "$USER_PRIORITY" | grep -vq '^nostr_user'; then
  echo "  FAIL  a nostr_user priority entry is not type-prefixed; it could collide with a nostr_event rule name"
  fails=$((fails+1))
else
  echo "  ok    nostr_user route names are type-prefixed (no org-wide collision)"
fi
# user_priority COMPLETENESS, derived like the nostr_event priority check above: every
# USER_CATROUTES row must appear, in the provisioning order, ahead of the match-all
# default. FIRST/LAST above cannot catch the documented shadowing hazard on their own --
# a route added to USER_CATROUTES (and pinned here) but forgotten in user_priority is
# appended AFTER the default by the reorder fallback and never fires (first-match-wins).
USER_PRIO_EXPECTED=$(printf '%s\n' "$USER_ROWS" | awk -F'|' '{ print "nostr_user: report_reason -> " $1 }'
  echo 'nostr_user -> General Review')
if [ "$USER_PRIORITY" = "$USER_PRIO_EXPECTED" ]; then
  echo "  ok    user_priority lists every USER_CATROUTES route, default last"
else
  echo "  FAIL  user_priority differs from USER_CATROUTES-derived route names:"
  diff <(printf '%s\n' "$USER_PRIO_EXPECTED") <(printf '%s\n' "$USER_PRIORITY") | sed 's/^/        /' || true
  echo "        Every USER_CATROUTES row needs a user_priority entry ahead of the General Review"
  echo "        default, or first-match-wins shadows it permanently."
  fails=$((fails+1))
fi

echo "the nostr_user enqueue rule is conditioned on report_reason (enrichment accounts get no job):"
# The 4b 'nostr_user -> review queue' content rule must fire ONLY when report_reason is
# present, so an ENRICHMENT account (COOPSink._submit_user_item, no report_reason) is NOT
# enqueued as its own review job -- only a REPORTED account (COOPSink._submit_reported_account,
# report_reason set) is. Extract the SHIPPED conditionSet builder and run it, then assert a
# CONTENT_FIELD report_reason condition whose pattern requires at least one character. A
# match-all (empty conditions) conditionSet must be REJECTED.
#
# The same predicate is applied to the real conditionSet AND to a match-all one, so the
# positive control cannot drift from the check it controls.
cat > "$WORK/uc_check.py" <<'PY'
import json, sys
cs = json.load(sys.stdin)
conds = cs.get("conditions") or []
def report_reason_present(c):
    field = c.get("input") or {}
    strings = (c.get("matchingValues") or {}).get("strings") or []
    # "^.+$" and friends require >=1 char, so an absent/empty report_reason does not match.
    # A '+'-quantified anchored pattern is the non-empty signal; '^$' / '' would match empty.
    signal = (c.get("signal") or {}).get("type")
    # EXACT shipped pattern, not a heuristic. A heuristic (anchored AND "+" present) would
    # pass a functionally broken pattern like "^+$"; require the precise "^.+$", which matches
    # any NON-EMPTY value and nothing empty, on the report_reason CONTENT_FIELD via the regex
    # signal. Anything else -- a broken pattern, "^$", a different field -- is a bug.
    return (field.get("type") == "CONTENT_FIELD"
            and field.get("name") == "report_reason"
            and signal == "TEXT_MATCHING_CONTAINS_REGEX"
            and strings == ["^.+$"])
print("OK" if (conds and any(report_reason_present(c) for c in conds)) else "FAIL")
PY
{ awk '/^nostr_user_review_condition_set\(\)/{flag=1} flag{print} flag && /^}/{exit}' "$SRC"; echo 'nostr_user_review_condition_set nostr-user-type'; } > "$WORK/uc_cond.sh"
UC_REAL=$(bash "$WORK/uc_cond.sh" 2>/dev/null | python3 "$WORK/uc_check.py" 2>/dev/null || echo FAIL)
if [ "$UC_REAL" = "OK" ]; then
  echo "  ok    nostr_user enqueue rule ships the exact report_reason-present pattern ^.+$"
else
  echo "  FAIL  the shipped nostr_user enqueue conditionSet is not the exact report_reason ^.+$ condition"
  fails=$((fails+1))
fi
# Positive control: the SAME check must REJECT a match-all (empty) conditionSet, or a revert
# to enqueuing every nostr_user item would slip through green.
UC_MATCHALL=$(printf '%s' '{"conditions":[],"conjunction":"AND"}' | python3 "$WORK/uc_check.py" 2>/dev/null || echo FAIL)
if [ "$UC_MATCHALL" = "FAIL" ]; then
  echo "  ok    the check rejects a match-all conditionSet (positive control)"
else
  echo "  FAIL  the conditioned-rule check passed a match-all conditionSet; it is vacuous"
  fails=$((fails+1))
fi
# Positive control 2: a report_reason condition whose pattern is functionally BROKEN ("^+$"
# quantifies nothing) must be rejected -- exactly what the old anchored-and-"+" heuristic let
# through. The exact-pattern check must not.
UC_BROKEN=$(printf '%s' '{"conditions":[{"input":{"type":"CONTENT_FIELD","name":"report_reason","contentTypeId":"x"},"signal":{"type":"TEXT_MATCHING_CONTAINS_REGEX"},"matchingValues":{"strings":["^+$"]}}],"conjunction":"AND"}' | python3 "$WORK/uc_check.py" 2>/dev/null || echo FAIL)
if [ "$UC_BROKEN" = "FAIL" ]; then
  echo "  ok    the check rejects a broken '^+$' pattern (positive control)"
else
  echo "  FAIL  the check accepted a broken '^+$' pattern; the exact-pattern assertion is not enforced"
  fails=$((fails+1))
fi
# The 4b SKIP must distinguish a foreign rule that is report_reason-conditioned from one
# that is not. "Some LIVE rule enqueues nostr_user" is the guarantee for nostr_event (step
# 4, match-all is correct there); for nostr_user the guarantee is narrower, and an
# unconditional foreign rule means every enrichment account gets its own job. A revert to
# existence-only skipping (no conditionSet in the rules query, no conditioned() predicate,
# no foreign_unconditioned branch) must go red here, not silently green.
if grep -q 'def conditioned' "$SRC" && grep -q 'foreign_unconditioned' "$SRC" && grep -qF "echo 'unknown|" "$SRC" && grep -qF 'rules is None' "$SRC"; then
  echo "  ok    the 4b skip verifies the foreign rule's conditioning, warns when it is unconditional, and degrades a failed query to unknown (not create)"
else
  echo "  FAIL  the 4b skip accepts ANY foreign nostr_user enqueue rule; a match-all foreign rule would be silently satisfied"
  fails=$((fails+1))
fi
# And the query the predicate reads must be VALID GraphQL: conditionSet is a composite
# type (type ConditionSet { conjunction, conditions }), so selecting it without a
# subselection makes the server reject the whole document -- the decision pipeline then
# hits its 2>/dev/null fallback and degrades to 'create' on EVERY run, silently. The
# identifier checks above stay green through that, so the query shape is pinned separately.
if grep -qF 'conditionSet { conditions' "$SRC"; then
  echo "  ok    the 4b rules query selects conditionSet with a subselection (a composite field without one is invalid GraphQL)"
else
  echo "  FAIL  the 4b rules query selects conditionSet without a subselection; the server rejects the document and the skip degrades to create every run"
  fails=$((fails+1))
fi
# EXECUTE the 4b decision against canonical payloads. String pins above cannot see a
# predicate that mis-executes: the empty-rules case below was a real defect (an empty
# list is a SUCCESSFUL answer meaning \"no rules exist\" and must yield create, but the
# unknown-detection's truthiness test swallowed it and 4b never provisioned a fresh org).
# Extraction mirrors how bash runs it: the python between `python3 -c "` and the closing
# quote, with bash's \$ escapes undone.
python3 - "$SRC" "$WORK/ucr_decision.py" <<'PY'
import sys
src = open(sys.argv[1], encoding='utf-8').read()
start = src.index('UCR_DECISION=$(echo "$EXISTING_UCR" | python3 -c')
start = src.index('python3 -c "', start) + len('python3 -c "')
end = src.index('" "$USER_CONTENT_RULE_NAME"', start)
code = src[start:end].replace('\\\n', '\n').replace('\\$', '$').replace('\\"', '"')
compile(code, 'ucr_decision', 'exec')
open(sys.argv[2], 'w', encoding='utf-8').write(code)
PY
UCR_COND_OK='{"conditions":[{"input":{"type":"CONTENT_FIELD","name":"report_reason","contentTypeId":"utid"},"signal":{"id":"{}","type":"TEXT_MATCHING_CONTAINS_REGEX"},"matchingValues":{"strings":["^.+$"]}}],"conjunction":"AND"}'
ucr_case() { # name expected-token payload-json
  local name="$1" want="$2" payload="$3" got
  got=$(printf '%s' "$payload" | python3 "$WORK/ucr_decision.py" "nostr_user -> review queue" "utid" 2>/dev/null | cut -d'|' -f1)
  if [ "$got" = "$want" ]; then
    echo "  ok    $name -> $want"
  else
    echo "  FAIL  $name: expected '$want', got '${got:-<none>}'"
    fails=$((fails+1))
  fi
}
ucr_case "a conditioned foreign rule satisfies 4b"            "satisfied"              "{\"data\":{\"myOrg\":{\"rules\":[{\"id\":\"r1\",\"name\":\"other\",\"status\":\"LIVE\",\"conditionSet\":$UCR_COND_OK,\"itemTypes\":[{\"name\":\"nostr_user\"}],\"actions\":[{\"__typename\":\"EnqueueToMrtAction\"}]}]}}}"
# Same payload with the condition scoped to ANOTHER item type: CONTENT_FIELD extraction
# requires inputSpecifier.contentTypeId === itemTypeId (leafCondition.ts), so such a rule
# can never fire for nostr_user and must not satisfy 4b. Deleting the contentTypeId clause
# from the shipped predicate turns this case red -- that mutation passed the whole suite
# green before this case existed.
ucr_case "a foreign rule scoped to another item type does not satisfy 4b" "foreign_unconditioned" "{\"data\":{\"myOrg\":{\"rules\":[{\"id\":\"r1\",\"name\":\"other\",\"status\":\"LIVE\",\"conditionSet\":{\"conditions\":[{\"input\":{\"type\":\"CONTENT_FIELD\",\"name\":\"report_reason\",\"contentTypeId\":\"othertid\"},\"signal\":{\"id\":\"{}\",\"type\":\"TEXT_MATCHING_CONTAINS_REGEX\"},\"matchingValues\":{\"strings\":[\"^.+\$\"]}}],\"conjunction\":\"AND\"},\"itemTypes\":[{\"name\":\"nostr_user\"}],\"actions\":[{\"__typename\":\"EnqueueToMrtAction\"}]}]}}}"
ucr_case "a match-all foreign rule warns (foreign_unconditioned)" "foreign_unconditioned" "{\"data\":{\"myOrg\":{\"rules\":[{\"id\":\"r1\",\"name\":\"evil\",\"status\":\"LIVE\",\"conditionSet\":{\"conditions\":[],\"conjunction\":\"AND\"},\"itemTypes\":[{\"name\":\"nostr_user\"}],\"actions\":[{\"__typename\":\"EnqueueToMrtAction\"}]}]}}}"
ucr_case "an EMPTY rules list is a successful answer (create)" "create"                 '{"data":{"myOrg":{"rules":[]}}}'
ucr_case "an errors payload degrades to unknown"              "unknown"                '{"errors":[{"message":"bad"}]}'
ucr_case "null data degrades to unknown"                      "unknown"                '{"data":null}'
ucr_case "our own rule present reconciles"                    "reconcile"              "{\"data\":{\"myOrg\":{\"rules\":[{\"id\":\"r1\",\"name\":\"nostr_user -> review queue\",\"status\":\"LIVE\",\"conditionSet\":{\"conditions\":[],\"conjunction\":\"AND\"},\"itemTypes\":[{\"name\":\"nostr_user\"}],\"actions\":[{\"__typename\":\"EnqueueToMrtAction\"}]}]}}}"

echo "the shipped account-moderation config is internally consistent:"
# Pins the COMPLETE shipped schema: name, type, required, IN ORDER.
#
# It reads the EVALUATED CT_FIELDS, not the literal assignment. It used to regex the
# literal, which WAS the artifact until this file started rewriting CT_FIELDS to append
# the profile fields. From that point a literal-regex check validated a value that is no
# longer what gets POSTed: inserting a rewrite between the literal and the splice silently
# downgraded media_url from VIDEO to STRING with the whole suite green.
#
# `required` matters more than it looks. Osprey OMITS six of the seven profile suffixes
# whenever it has nothing to say, and Coop rejects an ENTIRE item when a required field is
# absent, so flipping these to required:true would 400 every submission and strand every
# report. It is pinned here rather than left to reviewer attention.
extract_fields "$SRC" "$WORK/schema_block.sh" || { echo "FATAL: cannot read the shipped field declaration"; exit 1; }
cat > "$WORK/schema.check" <<'SHEOF'
set -euo pipefail
# shellcheck disable=SC1090
. "$1"
python3 - "$CT_FIELDS" "$CT_FIELD_ROLES" "$UT_FIELDS" <<'PYEOF'
import json
import sys

fields = json.loads(sys.argv[1])
roles = json.loads(sys.argv[2])
user_fields = json.loads(sys.argv[3])

expected_fields = [
    ("event_id", "STRING", True),
    ("source_event_id", "STRING", False),
    ("pubkey", "STRING", False),
    ("kind", "NUMBER", False),
    ("created_at", "NUMBER", False),
    ("verdict", "STRING", False),
    ("action_name", "STRING", False),
    ("report_reason", "STRING", False),
    ("reported_pubkey", "STRING", False),
    ("reported_event_id", "STRING", False),
    ("label_value", "STRING", False),
    ("label_namespace", "STRING", False),
    ("text", "STRING", False),
    ("media_url", "VIDEO", False),
    ("media_thumbnail", "IMAGE", False),
    ("media_sha256", "STRING", False),
    ("reporter_pubkey", "STRING", False),
    ("relay_manager_url", "URL", False),
    ("author", "RELATED_ITEM", False),
    # Profile enrichment, in EMISSION order (prefix x suffix). Order is pinned because the
    # setup script states that ordering decides where these read on a moderator's card.
    ("author_profile_state", "STRING", False),
    ("author_profile_error", "STRING", False),
    ("author_has_vanish_request", "BOOLEAN", False),
    ("author_display_name", "STRING", False),
    ("author_nip05", "STRING", False),
    ("author_nip05_verified", "BOOLEAN", False),
    ("author_follower_count", "NUMBER", False),
    ("reported_profile_state", "STRING", False),
    ("reported_profile_error", "STRING", False),
    ("reported_has_vanish_request", "BOOLEAN", False),
    ("reported_display_name", "STRING", False),
    ("reported_nip05", "STRING", False),
    ("reported_nip05_verified", "BOOLEAN", False),
    ("reported_follower_count", "NUMBER", False),
    ("reporter_profile_state", "STRING", False),
    ("reporter_profile_error", "STRING", False),
    ("reporter_has_vanish_request", "BOOLEAN", False),
    ("reporter_display_name", "STRING", False),
    ("reporter_nip05", "STRING", False),
    ("reporter_nip05_verified", "BOOLEAN", False),
    ("reporter_follower_count", "NUMBER", False),
]
actual_fields = [(f["name"], f["type"], f["required"]) for f in fields]
if actual_fields != expected_fields:
    raise SystemExit("FAIL: shipped content fields differ from the reviewed schema: %r" % (actual_fields,))

expected_roles = {
    "displayName": "text",
    "creatorId": "author",
    "threadId": None,
    "parentId": None,
    "createdAt": None,
    "isDeleted": None,
}
if roles != expected_roles:
    raise SystemExit("FAIL: shipped field roles differ from the reviewed schema: %r" % (roles,))

# The nostr_user type, pinned for the same reasons. `pubkey` required:True is the one
# osprey must always send; every profile field must stay optional, because osprey omits
# each of them whenever it has nothing to say and Coop rejects the WHOLE item when a
# required field is absent -- which here would strand the account card, not just a row.
expected_user_fields = [
    ("pubkey", "STRING", True),
    # report_reason: STRING, optional. Present so a PROFILE-ONLY report can be
    # ROUTED as a nostr_user item by the step 5b routes; absent means "not a
    # reported account here" (enrichment), which must be fine rather than a 400.
    ("report_reason", "STRING", False),
    ("npub", "STRING", False),
    ("first_seen_at", "DATETIME", False),
    # UNPREFIXED, in the same emission order as one prefix family above. These are what
    # the Associated User panel renders; prefixed names here would describe some other
    # account and show nothing.
    ("profile_state", "STRING", False),
    ("profile_error", "STRING", False),
    ("has_vanish_request", "BOOLEAN", False),
    ("display_name", "STRING", False),
    ("nip05", "STRING", False),
    ("nip05_verified", "BOOLEAN", False),
    ("follower_count", "NUMBER", False),
]
actual_user_fields = [(f["name"], f["type"], f["required"]) for f in user_fields]
if actual_user_fields != expected_user_fields:
    raise SystemExit("FAIL: shipped nostr_user fields differ from the reviewed schema: %r" % (actual_user_fields,))

PYEOF
SHEOF
check_script "the SHIPPED fields, types, required flags and field roles match the reviewed schema" 0 <(printf 'bash %q %q\n' "$WORK/schema.check" "$WORK/schema_block.sh")

ACTION_BLOCK="$WORK/actions.sh"
awk '/^  ACTIONS_LIST=/,/^  UNRESTRICT_STATUS=/' "$SRC" | sed '$d' > "$ACTION_BLOCK"
if ! grep -q '^  action_type_ids_json()' "$ACTION_BLOCK"; then
  echo "  FAIL  action scope function not captured"
  fails=$((fails+1))
else
  {
    printf 'TID=event-type\nUT_ID=user-type\n'
    cat "$ACTION_BLOCK"
    cat <<'SH'
COOP_ACCOUNT_ACTIONS=0
for action in "${ACTIONS_LIST[@]}"; do
  printf 'default:%s|%s\n' "$action" "$(action_type_ids_json "$action")"
done
COOP_ACCOUNT_ACTIONS=1
for action in "${ACTIONS_LIST[@]}"; do
  printf 'opt-in:%s|%s\n' "$action" "$(action_type_ids_json "$action")"
done
SH
  } > "$WORK/action-scopes.sh"
  ACTION_SCOPES=$(bash -euo pipefail "$WORK/action-scopes.sh" | grep '|')
  EXPECTED_ACTION_SCOPES=$(cat <<'SCOPES'
default:Age-Restrict|["event-type"]
default:Ban-User|["event-type"]
default:Delete-Content|["event-type"]
default:Hide-Content|["event-type"]
default:Restore-Content|["event-type"]
default:Suspend-User|["event-type"]
default:Un-Restrict-Media|["event-type"]
default:Unban-User|["event-type"]
default:Unsuspend-User|["event-type"]
opt-in:Age-Restrict|["event-type"]
opt-in:Ban-User|["event-type", "user-type"]
opt-in:Delete-Content|["event-type"]
opt-in:Hide-Content|["event-type"]
opt-in:Restore-Content|["event-type"]
opt-in:Suspend-User|["event-type", "user-type"]
opt-in:Un-Restrict-Media|["event-type"]
opt-in:Unban-User|["event-type", "user-type"]
opt-in:Unsuspend-User|["event-type", "user-type"]
SCOPES
  )
  SORTED_ACTION_SCOPES=$(printf '%s\n' "$ACTION_SCOPES" | LC_ALL=C sort)
  SORTED_EXPECTED_ACTION_SCOPES=$(printf '%s\n' "$EXPECTED_ACTION_SCOPES" | LC_ALL=C sort)
  if [ "$SORTED_ACTION_SCOPES" = "$SORTED_EXPECTED_ACTION_SCOPES" ]; then
    echo "  ok    account actions add nostr_user only when COOP_ACCOUNT_ACTIONS=1"
  else
    echo "  FAIL  shipped action set or scopes differ from the required config:"
    diff <(printf '%s\n' "$EXPECTED_ACTION_SCOPES") <(printf '%s\n' "$ACTION_SCOPES") | sed 's/^/        /' || true
    fails=$((fails+1))
  fi
fi

for payload in UV AV; do
  line=$(grep -E "^[[:space:]]+$payload=" "$SRC" | grep -F 'COOP_ADAPTER_URL/webhook/$AN' || true)
  if [ "$payload" = UV ]; then scope_key='"itemTypeIds":json.loads(sys.argv[4])'; else scope_key='"itemTypeIds":json.loads(sys.argv[2])'; fi
  if [ "$(printf '%s\n' "$line" | grep -cF "$scope_key")" -eq 1 ] &&
     [ "$(printf '%s\n' "$line" | grep -cF '$(action_type_ids_json "$AN")')" -eq 1 ]; then
    echo "  ok    $payload mutation payload declares and receives the tested action scope"
  else
    echo "  FAIL  $payload mutation payload does not consume action_type_ids_json"
    fails=$((fails+1))
  fi
done

if [ "$(grep -Ec '^[[:space:]]*echo ".*adapter.*nostr_user action targets' "$SRC")" -eq 2 ]; then
  echo "  ok    adapter compatibility appears in both runtime opt-in messages"
else
  echo "  FAIL  runtime adapter compatibility messages are missing"
  fails=$((fails+1))
fi

cat > "$WORK/action_state_init.check" <<'SH'
python3 - "$1" <<'PY'
import sys

src = open(sys.argv[1], encoding="utf-8").read()
init = src.find('\nUNVERIFIED_CALLBACKS=""\n')
branch = src.find('\nif [ -z "${WEBHOOK_SECRET:-}" ]; then\n')
if init < 0 or branch < 0 or init > branch:
    raise SystemExit("UNVERIFIED_CALLBACKS must be reset before the WEBHOOK_SECRET branch")
PY
SH
check_script "internal callback state resets before both secret branches" 0 <(printf 'bash %q %q\n' "$WORK/action_state_init.check" "$SRC")

probe_line=$(grep 'UNRESTRICT_STATUS=.*webhook/Un-Restrict-Media' "$SRC" || true)
if [ "$(printf '%s\n' "$probe_line" | grep -cF 'x-webhook-secret: $WEBHOOK_SECRET')" -eq 1 ] &&
   ! printf '%s\n' "$probe_line" | grep -qF '__coop_setup_route_probe__'; then
  echo "  ok    route probe authenticates before interpreting route status"
else
  echo "  FAIL  route probe cannot reach adapter route dispatch"
  fails=$((fails+1))
fi

echo "enforcement action scoping:"
cat > "$WORK/action_scope.check" <<'SH'
TID=nostr-event-type
UT_ID=nostr-user-type
. "$1"
[ "$(COOP_ACCOUNT_ACTIONS=0 action_type_ids_json Ban-User)" = '["nostr-event-type"]' ]
[ "$(COOP_ACCOUNT_ACTIONS=1 action_type_ids_json Ban-User)" = '["nostr-event-type", "nostr-user-type"]' ]
[ "$(COOP_ACCOUNT_ACTIONS=1 action_type_ids_json Delete-Content)" = '["nostr-event-type"]' ]
SH
check_script "nostr_user action scope is opt-in and content actions stay content-only" 0 <(printf 'bash %q %q\n' "$WORK/action_scope.check" "$WORK/action_scope.sh")

echo "adapter probe classification:"
cat > "$WORK/probe_status.check" <<'SH'
. "$1"

COOP_ADAPTER_URL=http://adapter
ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=503
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = yes ]
case "$UNVERIFIED_CALLBACKS" in *503*) ;; *) exit 1 ;; esac

ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=401
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = yes ]
case "$UNVERIFIED_CALLBACKS" in *401*) ;; *) exit 1 ;; esac

ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=403
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = yes ]
case "$UNVERIFIED_CALLBACKS" in *403*) ;; *) exit 1 ;; esac

ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=400
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = yes ]
[ -z "$UNVERIFIED_CALLBACKS" ]

ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=429
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = yes ]
case "$UNVERIFIED_CALLBACKS" in *429*) ;; *) exit 1 ;; esac

ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=404
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = partial ]
[ "${ACTIONS_LIST[*]}" = "Ban-User Suspend-User Unban-User Unsuspend-User Delete-Content Hide-Content Restore-Content Age-Restrict" ]
case "$SKIPPED_ACTIONS" in *Un-Restrict-Media*) ;; *) exit 1 ;; esac

ACTIONS_LIST=(Ban-User Un-Restrict-Media)
ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
UNRESTRICT_STATUS=000
record_adapter_probe_status >/dev/null
[ "$ACTIONS_PROVISIONED" = yes ]
case "$UNVERIFIED_CALLBACKS" in *000*) ;; *) exit 1 ;; esac
SH
check_script "expected, missing, auth, server, transport, and unexpected probe statuses classify distinctly" 0 <(printf 'bash %q %q\n' "$WORK/probe_status.check" "$WORK/probe.sh")

echo "final banner states:"
cat > "$WORK/banner.check" <<'SH'
. "$1"

ACTIONS_PROVISIONED=yes
SKIPPED_ACTIONS=""
UNVERIFIED_CALLBACKS=""
COOP_ACCOUNT_ACTIONS=0
out=$(print_done_banner)
case "$out" in *"Account action buttons are NOT enabled for nostr_user"*) ;; *) exit 1 ;; esac
case "$out" in *"only after the adapter can handle nostr_user action targets"*) ;; *) exit 1 ;; esac
case "$out" in *"callbacks is confirmed"*) exit 1 ;; esac

ACTIONS_PROVISIONED=partial
SKIPPED_ACTIONS="Un-Restrict-Media"
UNVERIFIED_CALLBACKS="adapter returned HTTP 503"
COOP_ACCOUNT_ACTIONS=1
out=$(print_done_banner)
case "$out" in *"PARTIALLY provisioned"*"Un-Restrict-Media"*503*) ;; *) exit 1 ;; esac
case "$out" in *"Account action buttons are NOT enabled"*) exit 1 ;; esac
SH
check_script "banner reports action and callback state without inherited leakage" 0 <(printf 'bash %q %q\n' "$WORK/banner.check" "$WORK/banner.sh")

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
# `read -ra` on a here-string sees only the FIRST line, so without this arm a wrapped array
# element shipped ^csam\n$ -- a pattern matching nothing, silently disabling the CSAM route.
check "newline inside a token list (wrapped array element)" 1 "label_value|CSAM|csam
,sexual_minors"

# --- Positive controls for the schema pin ---------------------------------------------
#
# The pin above is only a guard if it can go red. These mutate the SHIPPED script and
# require the pin to reject the result. Three properties make them non-vacuous:
#
#   1. Each asserts its own mutation applied. A sed that silently matches nothing would
#      otherwise "pass" by testing the unmodified file.
#   2. Rejection must come from the PIN, not from collateral damage. An earlier version
#      compared output strings, so a mutation that merely broke bash produced different
#      output and scored a pass while proving nothing. A control now has to see either a
#      FAIL: from the schema check or an unreadable field block, and says which.
#   3. They drive the real schema check, not a parallel re-implementation of it. A control
#      that exercises a copy of the pin cannot tell you the shipped pin discriminates.
#
# The first control is the one that matters most, and is the reason this section exists:
# the generator can be perfectly correct while its output never reaches CT_FIELDS.
pin_control() { # name expected-message-fragment sed-expression
  local name="$1" want="$2" expr="$3" out rc
  sed "$expr" "$SRC" > "$WORK/ctl_src.sh"
  if cmp -s "$SRC" "$WORK/ctl_src.sh"; then
    printf '  FAIL  %s -- mutation did not apply, so this control tested nothing\n' "$name"
    fails=$((fails+1)); return
  fi
  if ! extract_fields "$WORK/ctl_src.sh" "$WORK/ctl_block.sh" >/dev/null 2>&1; then
    printf '  ok    %s (rejected: field declaration unreadable)\n' "$name"; return
  fi
  out=$(bash "$WORK/schema.check" "$WORK/ctl_block.sh" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "$want"; then
    printf '  ok    %s (rejected by the schema pin)\n' "$name"
  elif [ "$rc" -ne 0 ]; then
    printf '  FAIL  %s -- rejected, but NOT by the pin (the mutation broke the script): %s\n' "$name" "$(printf '%s' "$out" | tail -1)"
    fails=$((fails+1))
  else
    printf '  FAIL  %s -- the pin did not notice\n' "$name"
    fails=$((fails+1))
  fi
}

# The schema pin evaluates CT_FIELDS as of the end marker, but the values that reach
# updateContentItemType / createContentItemType are read further down. Anything in between
# is outside the pin: re-assigning CT_FIELDS one line BELOW the marker downgrades media_url
# to STRING, and re-assigning CT_FIELD_ROLES unbinds creatorId from author so the
# Associated User panel stops resolving. Both left every check green.
#
# This is the same single-execution-point gap the CATROUTES count guard above exists to
# close, and it gets the same treatment: assert there is no room for a second assignment
# rather than trying to evaluate the script at the point of use.
cat > "$WORK/boundary.check" <<'SHEOF'
set -euo pipefail
src="$1"

# Exactly one marker, asserted before use. Two markers made `mark` hold an embedded
# newline, which killed awk with a parse error before any of this script's own messages
# could run -- loud, but undiagnosable. It is also the only assertion here that no control
# could distinguish, because with mark empty the awk below did a STRING comparison in which
# every line satisfies NR > m, so it fired instead and blamed lines inside the region.
marks=$(grep -c '^# --- end field declaration ---$' "$src" || true)
[ "$marks" -eq 1 ] || { echo "FAIL: expected exactly 1 end-of-declaration marker, found $marks; the pinned region has no unambiguous lower bound"; exit 1; }
mark=$(grep -n '^# --- end field declaration ---$' "$src" | cut -d: -f1)

# POSITION, not count. An earlier version asserted "CT_FIELDS is assigned exactly twice",
# which fired on a legitimate second generated family spliced INSIDE the pinned region and
# told the developer, falsely, that something had escaped it. The obvious repair to a wrong
# diagnosis is to bump the number, which would permanently admit one real escape. A guard
# whose message can be false teaches people to weaken it.
# `m+0` forces a numeric compare; without it a non-integer m silently compares as a string.
escaped=$(awk -v m="$mark" 'NR > m+0 && /^[[:space:]]*(export|readonly|declare|typeset|local)?[[:space:]]*(CT_FIELDS|CT_FIELD_ROLES|UT_FIELDS)\+?=/ { print NR": "$0 }' "$src")
[ -z "$escaped" ] || {
  echo "FAIL: a schema assignment sits BELOW the pinned region, so the schema pin evaluates one value while a different one is provisioned:"
  echo "$escaped"
  exit 1
}

# FLOOR first. The per-call-site rule below only constrains lines that already match, so on
# its own it is vacuous exactly when it matters most: rename CT_VARS and the set is empty,
# every line "passes", and the pin governs nothing. Assert the pinned pair is read at all
# before asserting where it is read.
# Comment lines excluded: a stale comment mentioning the pair satisfied a bare count,
# which reopened the exact vacuity this floor exists to close.
uses=$(grep -F '"$CT_FIELDS" "$CT_FIELD_ROLES"' "$src" | grep -vc '^[[:space:]]*#' || true)
[ "$uses" -ge 1 ] || { echo "FAIL: nothing in the script reads the pinned (CT_FIELDS, CT_FIELD_ROLES) pair, so the schema pin governs nothing that is actually provisioned"; exit 1; }

# Same floor for the user type. UT_FIELDS is pinned too now, so it needs its own proof that
# the pinned value is the provisioned one; without this the nostr_user half of the pin goes
# vacuous the moment the variable is renamed, in exactly the way described above.
ut_uses=$(grep -F '"$UT_FIELDS"' "$src" | grep -vc '^[[:space:]]*#' || true)
[ "$ut_uses" -ge 1 ] || { echo "FAIL: nothing in the script reads the pinned UT_FIELDS, so the nostr_user schema pin governs nothing that is actually provisioned"; exit 1; }

# Then per call site, so extracting the two near-identical printf calls into one helper --
# an obvious cleanup -- does not trip it. Continuations are joined first: the provisioning
# lines are ~250 chars, so wrapping one is the likeliest edit of all, and matching per
# PHYSICAL line would accuse a wrapped call of dropping a variable that is right there on
# the next line. -F because the pattern contains $( , which is not a literal in a regex.
logical=$(awk '{ buf = buf $0 } /\\[[:space:]]*$/ { sub(/\\[[:space:]]*$/, "", buf); next } { print NR": "buf; buf = "" } END { if (buf != "") print NR": "buf }' "$src")
bad=$(printf '%s\n' "$logical" | grep -F 'CT_VARS=$(printf' | grep -vF '"$CT_FIELDS" "$CT_FIELD_ROLES"' || true)
[ -z "$bad" ] || {
  echo "FAIL: a provisioning call does not send the pinned (CT_FIELDS, CT_FIELD_ROLES) pair, so it bypasses the schema pin:"
  echo "$bad"
  exit 1
}

# SCOPE, stated honestly: this catches an assignment a future edit puts in the wrong place.
# It is syntactic, so it does not catch deliberate evasion (eval, printf -v, declare -n, a
# nameref) nor an assignment hidden after a semicolon on a shared line. That is the right
# trade -- the risk here is a careless edit, not an attacker with commit access -- but the
# limit belongs in writing rather than in someone's head.
SHEOF
echo "the pinned region actually reaches the provisioning call:"
check_script "no schema assignment escapes the pinned region" 0 <(printf 'bash %q %q\n' "$WORK/boundary.check" "$SRC")

# Controls for the boundary guard, so it is not itself a check that cannot go red.
# A control must name WHICH assertion it expects to trip. Matching a bare "FAIL:" let a
# control pass on a NEIGHBOUR's failure: an unanchored sed hit both provisioning branches,
# emptied the floor, and the control scored the floor's message as proof that the
# per-call-site rule works -- leaving that rule with no coverage at all. It could then be
# deleted outright with the suite fully green. Requiring the expected message makes a
# control incapable of borrowing another's evidence.
boundary_control() { # name expected-message-fragment sed-expression
  local name="$1" want="$2" expr="$3" out rc
  sed "$expr" "$SRC" > "$WORK/bctl_src.sh"
  if cmp -s "$SRC" "$WORK/bctl_src.sh"; then
    printf '  FAIL  %s -- mutation did not apply, so this control tested nothing\n' "$name"
    fails=$((fails+1)); return
  fi
  out=$(bash "$WORK/boundary.check" "$WORK/bctl_src.sh" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  FAIL  %s -- the boundary guard did not notice\n' "$name"
    fails=$((fails+1))
  elif printf '%s' "$out" | grep -qF "$want"; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s -- rejected, but by a DIFFERENT assertion than this control covers (wanted %s): %s\n' \
      "$name" "$want" "$(printf '%s' "$out" | head -1)"
    fails=$((fails+1))
  fi
}

boundary_control "CT_FIELDS re-assigned below the marker (media_url VIDEO -> STRING)" "sits BELOW the pinned region" 's|^# --- end field declaration ---$|&\nCT_FIELDS="${CT_FIELDS//VIDEO/STRING}"|'
boundary_control "CT_FIELD_ROLES re-assigned below the marker (creatorId unbound)" "sits BELOW the pinned region"    's|^# --- end field declaration ---$|&\nCT_FIELD_ROLES="${CT_FIELD_ROLES//author/null}"|'
boundary_control "ONE provisioning branch sends a different variable" "does not send the pinned" '/"input":{"name":"nostr_event"/s|"\$CT_FIELDS" "\$CT_FIELD_ROLES"|"$OTHER_FIELDS" "$OTHER_ROLES"|'
boundary_control "CT_VARS is renamed so no call site matches (guard would go vacuous)" "nothing in the script reads the pinned" 's/CT_VARS=\$(printf/CTV=$(printf/; s/"\$CT_FIELDS" "\$CT_FIELD_ROLES"/"$OTHER_A" "$OTHER_B"/'
boundary_control "a schema assignment below the marker is exported" "sits BELOW the pinned region"                  's|^# --- end field declaration ---$|&\nexport CT_FIELDS="${CT_FIELDS//VIDEO/STRING}"|'
boundary_control "UT_FIELDS re-assigned below the marker (account card types downgraded)" "sits BELOW the pinned region" 's|^# --- end field declaration ---$|&\nUT_FIELDS="${UT_FIELDS//BOOLEAN/STRING}"|'
boundary_control "nothing reads the pinned UT_FIELDS (guard would go vacuous)" "nothing in the script reads the pinned UT_FIELDS" 's/"\$UT_FIELDS"/"$OTHER_UT"/g'
boundary_control "a second end-of-declaration marker appears" "end-of-declaration marker, found"                        's|^# --- end field declaration ---$|&\n# --- end field declaration ---|'
boundary_control "the end-of-declaration marker is deleted" "end-of-declaration marker, found"                          '/^# --- end field declaration ---$/d'

echo "positive controls: the schema pin discriminates:"
# Seven controls, not nine. Three were provably redundant: a neuter matrix over partial
# degradations of the pin showed "a whole prefix is dropped", "a field is removed from the
# rule" and "CT_FIELDS is rewritten after the literal" went red in exactly the same cases as
# controls kept below, so they cost maintenance and bought no detection. The ones kept are
# each tied to one way the pin can weaken: name, type, ORDER, required, field roles, and
# the splice never reaching the artifact.
pin_control "the splice is deleted (generator correct, CT_FIELDS never gets it)" "shipped content fields differ" '/^CT_FIELDS="${CT_FIELDS%]}\$(profile_fields_json)]"$/d'
pin_control "a field is renamed" "shipped content fields differ"                                                 's/display_name:STRING/displayname:STRING/'
pin_control "a field type changes (BOOLEAN -> STRING)" "shipped content fields differ"                           's/nip05_verified:BOOLEAN/nip05_verified:STRING/'
pin_control "the emission ORDER changes" "shipped content fields differ"                                         's/profile_state:STRING profile_error:STRING/profile_error:STRING profile_state:STRING/'
pin_control "displayName points at the event id instead of the post text" "shipped field roles differ" 's/"displayName":"text"/"displayName":"event_id"/'
pin_control "creatorId is unbound from author (Associated User panel stops resolving)" "shipped field roles differ" 's/"creatorId":"author"/"creatorId":null/'
# required:true would make Coop 400 every submission, because osprey omits six of the
# seven suffixes whenever it has nothing to say.
pin_control "the profile fields become required" "shipped content fields differ"                                 's/,\"required\":false}/,\"required\":true}/'

# The same three ways the ACCOUNT card can silently lose its fields. Each of these leaves
# the content type completely intact, so the controls above stay green while the
# Associated User panel goes back to "No user information found".
pin_control "the nostr_user splice is deleted (account card loses every profile field)" "shipped nostr_user fields differ" '/user_profile_fields_json)]"$/d'
pin_control "the nostr_user fields are prefixed (they would describe another account)" "shipped nostr_user fields differ"  's/user_profile_fields_json)]/profile_fields_json)]/'
# pubkey is the one field osprey must always send; optional here means a submission that
# omits it is accepted and the account item carries no identity at all.
pin_control "pubkey stops being required on nostr_user" "shipped nostr_user fields differ" 's/{"name":"pubkey","type":"STRING","required":true}/{"name":"pubkey","type":"STRING","required":false}/'

# The two ways the nostr_user ROUTING invariants can silently weaken. Unlike the schema
# pin controls above, these re-run the WHOLE guard against a mutated copy of the setup
# script in a throwaway tree (pin_control only re-runs schema.check, which does not read
# routing config at all). The env var stops a control-of-controls recursing: the child
# suite's own routing_controls become no-ops, so each control runs exactly one level deep.
routing_control() { # name expected-message-fragment sed-expression
  local name="$1" want="$2" expr="$3" out rc
  [ -n "${COOP_GUARD_IN_ROUTING_CTL:-}" ] && return 0
  mkdir -p "$WORK/ctl_repo/divine"
  sed "$expr" "$SRC" > "$WORK/ctl_repo/divine/coop-setup-org.sh"
  cp divine/test-coop-setup-guards.sh "$WORK/ctl_repo/divine/"
  out=$(COOP_GUARD_IN_ROUTING_CTL=1 bash "$WORK/ctl_repo/divine/test-coop-setup-guards.sh" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF "$want"; then
    printf '  ok    %s (rejected by the guard)\n' "$name"
  elif [ "$rc" -ne 0 ]; then
    printf '  FAIL  %s -- rejected, but NOT with the expected message: %s\n' "$name" "$(printf '%s' "$out" | tail -1)"
    fails=$((fails+1))
  else
    printf '  FAIL  %s -- the guard did not notice\n' "$name"
    fails=$((fails+1))
  fi
}
# Dropping a middle user_priority entry is the shadowing hazard the reorder fallback
# creates (a route appended after the match-all default never fires); FIRST/LAST stay
# green, so only the derived completeness comparison catches it.
routing_control "a middle user_priority entry is dropped (that route is shadowed after the default)" "user_priority differs from USER_CATROUTES-derived" '/^  "nostr_user: report_reason -> Sexual Content",$/d'
# Renaming the marker away restores the silent existence-only skip a foreign match-all
# rule could hide behind (the containment check above goes red, not the schema pin).
routing_control "the foreign-rule conditioning check is removed (silent match-all skip returns)" "silently satisfied" 's/foreign_unconditioned/satisfied2/g'
# Bare `conditionSet` (no subselection) is invalid GraphQL for a composite type; the
# server rejects the whole query and the F3 fallback degrades 4b to create on every run.
routing_control "the 4b query loses its conditionSet subselection (invalid GraphQL, silent create-fallback)" "selects conditionSet without a subselection" 's/conditionSet { conditions/conditionSet/'
# The truthiness form of the round-4 defect: `not rules` swallows the empty list, so a
# fresh org (no rules yet) is reported as a failed query and 4b never provisions.
routing_control "an empty rules list is swallowed by the unknown-detection again (truthiness bug)" "expected 'create', got 'unknown'" 's/rules is None/not rules/'

if [ "$fails" -ne 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all guard tests passed"
