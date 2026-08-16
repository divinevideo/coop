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

echo "the shipped account-moderation config is internally consistent:"
cat > "$WORK/content_fields.check" <<'SH'
python3 - "$1" <<'PY'
import json
import re
import sys

src = open(sys.argv[1], encoding="utf-8").read()

def assignment(name):
    match = re.search(rf"^{name}='([^']*)'$", src, re.M)
    if not match:
        raise SystemExit(f"FAIL: {name} assignment not found")
    return json.loads(match.group(1))

fields = assignment("CT_FIELDS")
roles = assignment("CT_FIELD_ROLES")
by_name = {field["name"]: field for field in fields}

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
]
actual_fields = [(field["name"], field["type"], field["required"]) for field in fields]
if actual_fields != expected_fields:
    raise SystemExit(f"FAIL: content fields differ from the reviewed schema: {actual_fields!r}")

author = by_name.get("author")
if author != {"name": "author", "type": "RELATED_ITEM", "required": False}:
    raise SystemExit(f"FAIL: author field is not the expected optional RELATED_ITEM: {author!r}")
if roles.get("creatorId") != "author":
    raise SystemExit(f"FAIL: creatorId role does not reference author: {roles.get('creatorId')!r}")

PY
SH
check_script "content fields and creatorId match the reviewed producer-independent schema" 0 <(printf 'bash %q %q\n' "$WORK/content_fields.check" "$SRC")

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

# --- Profile enrichment fields -------------------------------------------------------
#
# The 21 profile fields are GENERATED in the setup script from a prefix x suffix rule,
# because osprey generates them the same way (divine/plugins/src/coop_profile.py builds
# every key as f'{prefix}_{suffix}'). A hand-typed list of 21 strings on the consumer side
# is exactly what drifts from a generated list on the producer side. So the script derives
# and this test PINS: the script cannot rot by typo, and the derivation cannot change
# silently, because changing PROFILE_PREFIXES or PROFILE_SUFFIX_TYPES makes the pin go red.
#
# READ THE ARTIFACT, NOT THE GENERATOR. An earlier version of this block called
# profile_fields_json directly. That proved the generator produced 21 correct names and
# proved NOTHING about whether they reached CT_FIELDS -- the string actually POSTed to
# Coop. Deleting the splice line left this suite entirely green while provisioning a
# 19-field org, and the well-formedness check printed "19 fields" without asserting it.
# Everything below extracts from $CT_FIELDS after the shipped assignment has run.
extract_fields() { # src dest -- capture the shipped field declaration from a source file
  awk '/^CT_FIELDS=/{f=1} f{print} f && /^# --- end field declaration/{exit}' "$1" > "$2"
  grep -q '^profile_fields_json()' "$2" || { echo "FATAL: profile field generator not captured from $1"; exit 1; }
  grep -q 'end field declaration' "$2"  || { echo "FATAL: field declaration range never terminated in $1"; exit 1; }
}

# name:TYPE, not name alone. Type is load-bearing: the queue preview selects on type, so a
# BOOLEAN declared STRING moves where a moderator sees it, and follower_count as STRING
# sorts lexically. A name-only pin let nip05_verified BOOLEAN -> STRING through.
# The three identifier fields are excluded: osprey sets them directly, they are not built
# by the prefix x suffix rule, and including them would make this pin drift-blind to the
# rule it exists to pin.
PF_EXTRACT='printf "%s" "$CT_FIELDS" | grep -oE "\"name\":\"(author|reported|reporter)_[a-z0-9_]+\",\"type\":\"[A-Z_]+\"" | grep -vE "\"name\":\"(reported_pubkey|reported_event_id|reporter_pubkey)\"" | sed "s/\"name\":\"//; s/\",\"type\":\"/:/; s/\"\$//" | LC_ALL=C sort'

profile_names_from() { # src -> sorted "name:TYPE" lines from the SHIPPED CT_FIELDS
  extract_fields "$1" "$WORK/pf_fields.sh"
  { cat "$WORK/pf_fields.sh"; printf '%s\n' "$PF_EXTRACT"; } > "$WORK/pf_names.sh"
  run "$WORK/pf_names.sh"
}

# Pinned by construction: 3 prefixes x 7 suffixes. Written longhand on purpose -- a pin
# that recomputes the rule it is pinning proves nothing.
EXPECTED_PROFILE=$(cat <<'PFIELDS'
author_display_name:STRING
author_follower_count:NUMBER
author_has_vanish_request:BOOLEAN
author_nip05:STRING
author_nip05_verified:BOOLEAN
author_profile_error:STRING
author_profile_state:STRING
reported_display_name:STRING
reported_follower_count:NUMBER
reported_has_vanish_request:BOOLEAN
reported_nip05:STRING
reported_nip05_verified:BOOLEAN
reported_profile_error:STRING
reported_profile_state:STRING
reporter_display_name:STRING
reporter_follower_count:NUMBER
reporter_has_vanish_request:BOOLEAN
reporter_nip05:STRING
reporter_nip05_verified:BOOLEAN
reporter_profile_error:STRING
reporter_profile_state:STRING
PFIELDS
)

echo "the shipped CT_FIELDS carries the pinned profile fields:"
ACTUAL_PROFILE=$(profile_names_from "$SRC") || { echo "  FAIL  extraction errored"; fails=$((fails+1)); ACTUAL_PROFILE=''; }
if [ "$ACTUAL_PROFILE" = "$EXPECTED_PROFILE" ]; then
  echo "  ok    21 profile fields reach CT_FIELDS, names and types as osprey builds them"
else
  echo "  FAIL  profile fields in CT_FIELDS drifted from the pin"
  diff <(printf '%s\n' "$EXPECTED_PROFILE") <(printf '%s\n' "$ACTUAL_PROFILE") | sed 's/^/        /'
  fails=$((fails+1))
fi

# Positive controls. A pin that has never been seen to go red is indistinguishable from one
# that compares nothing. Each control asserts its OWN mutation applied first -- a sed that
# silently matches nothing would otherwise "pass" by testing the unmodified file.
pin_control() { # name sed-expression
  local name="$1" expr="$2" got
  sed "$expr" "$SRC" > "$WORK/pf_mut.sh"
  if cmp -s "$SRC" "$WORK/pf_mut.sh"; then
    printf '  FAIL  %s -- mutation did not apply, so this control tested nothing\n' "$name"
    fails=$((fails+1)); return
  fi
  got=$(profile_names_from "$WORK/pf_mut.sh" 2>/dev/null) || got=''
  if [ "$got" != "$EXPECTED_PROFILE" ]; then printf '  ok    %s\n' "$name"
  else printf '  FAIL  %s -- the pin did not notice\n' "$name"; fails=$((fails+1)); fi
}

echo "positive controls: the pin discriminates:"
# The one that matters most: the generator is correct but its output never reaches the
# artifact. This is what the previous version of this test could not see.
pin_control "the splice is deleted (generator fine, CT_FIELDS unchanged)" '/^CT_FIELDS="${CT_FIELDS%]}\$(profile_fields_json)]"$/d'
pin_control "a whole prefix is dropped (card loses reporter identity)"    's/^PROFILE_PREFIXES="author reported reporter"$/PROFILE_PREFIXES="author reported"/'
pin_control "a field is renamed"                                          's/display_name:STRING/displayname:STRING/'
pin_control "a field type changes (BOOLEAN -> STRING)"                    's/nip05_verified:BOOLEAN/nip05_verified:STRING/'
pin_control "a field is removed from the rule"                            's/ nip05:STRING//'

# Every field Coop is given is rendered, and a duplicate name is a field defined twice with
# no indication which wins. The COUNT is asserted, not merely printed: printing it is how a
# 19-field org read as healthy.
echo "the shipped CT_FIELDS is well-formed:"
extract_fields "$SRC" "$WORK/wf_fields.sh"
{ cat "$WORK/wf_fields.sh"
  printf '%s\n' 'printf "%s" "$CT_FIELDS" | python3 -c "
import json,sys
fields = json.load(sys.stdin)
names = [f[\"name\"] for f in fields]
dupes = {n for n in names if names.count(n) > 1}
assert not dupes, f\"duplicate field names: {sorted(dupes)}\"
allowed = {\"STRING\",\"NUMBER\",\"BOOLEAN\",\"URL\",\"IMAGE\",\"VIDEO\",\"RELATED_ITEM\"}
bad = {f[\"name\"]: f[\"type\"] for f in fields if f[\"type\"] not in allowed}
assert not bad, f\"unknown field types: {bad}\"
assert len(fields) == 40, f\"expected 40 fields (19 core + 21 profile), got {len(fields)}\"
print(len(fields))
"'
} > "$WORK/wellformed.sh"
COUNT=$(run "$WORK/wellformed.sh") && rc=0 || rc=$?
if [ "${rc:-0}" -eq 0 ]; then echo "  ok    valid JSON, no duplicate names, all types known, $COUNT fields"
else echo "  FAIL  CT_FIELDS malformed: $COUNT"; fails=$((fails+1)); fi

if [ "$fails" -ne 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all guard tests passed"
