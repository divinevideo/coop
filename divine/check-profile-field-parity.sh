#!/usr/bin/env bash
# Cross-repo drift check: do the profile fields coop DECLARES match the ones osprey EMITS?
#
# coop-setup-org.sh derives its 21 profile fields from a prefix x suffix rule, and
# divine/test-coop-setup-guards.sh pins that derivation. But a pin only proves coop is
# self-consistent. It cannot prove coop agrees with the OTHER repo, and the two share no
# runtime, so nothing in either CI can notice them diverging. That is the same reason
# CANONICAL_REASONS is vendored with a fail-loud guard rather than imported.
#
# This closes that gap on demand. It does not run in CI, because CI has no osprey checkout;
# run it when either side's field list changes, and before provisioning a new org.
#
# The check EXECUTES osprey's real builder over every branch rather than grepping it: a
# grep sees the keys a developer typed, while running it sees the keys a moderator gets.
# Those differ exactly when it matters -- a key built conditionally, or one whose name is
# assembled at runtime.
#
# Usage: divine/check-profile-field-parity.sh [path-to-osprey] [git-ref]
#   defaults: ../osprey, origin/main
set -euo pipefail
cd "$(dirname "$0")/.."

OSPREY="${1:-../osprey}"
REF="${2:-origin/main}"
SRC=divine/coop-setup-org.sh

[ -d "$OSPREY/.git" ] || { echo "ERROR: no osprey checkout at '$OSPREY' (pass the path as \$1)"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# --- what osprey emits ---------------------------------------------------------------
# Read from a git ref, not the working tree: an uncommitted local edit would make this
# report parity that no deployed image has.
git -C "$OSPREY" show "$REF:divine/plugins/src/coop_profile.py" > "$WORK/coop_profile.py" 2>/dev/null || {
  echo "ERROR: $REF:divine/plugins/src/coop_profile.py not found in $OSPREY"; exit 1; }

python3 - "$WORK" > "$WORK/osprey.txt" <<'PY'
import sys, pathlib
sys.path.insert(0, sys.argv[1])
import coop_profile as cp

# Every branch of profile_fields(), so a key emitted on only one path still counts.
CASES = [
    None,                                                     # lookup failed
    {},                                                       # no profile
    {'has_vanish_request': True},                             # vanish request, no profile
    {'profile': {'display_name': 'Sam'}, 'social': {'follower_count': 5}},
    {'profile': {'name': 'fallback', 'nip05': 'a@b.c', 'nip05_verified': True},
     'social': {'follower_count': 0}, 'has_vanish_request': True},
    {'profile': {'nip05': 'x@y.z', 'nip05_verified': False}, 'social': {}},
]
keys = set()
for prefix in ('author', 'reported', 'reporter'):
    for case in CASES:
        keys |= set(cp.profile_fields(case, prefix=prefix, error='e'))
print('\n'.join(sorted(keys)))
PY

# --- what coop declares --------------------------------------------------------------
# Evaluate the SHIPPED assignment, so this checks the artifact provisioned to Coop rather
# than a copy of it.
awk '/^CT_FIELDS=/{f=1} f{print} f && /^# --- end field declaration/{exit}' "$SRC" > "$WORK/fields.sh"
grep -q '^profile_fields_json()' "$WORK/fields.sh" || { echo "ERROR: field declaration not captured from $SRC"; exit 1; }

# shellcheck disable=SC1090
( set -euo pipefail; . "$WORK/fields.sh"; printf '%s' "$CT_FIELDS" ) \
  | python3 -c '
import json, sys
declared = {f["name"] for f in json.load(sys.stdin)}
prefixes = ("author_", "reported_", "reporter_")
# Only the enrichment fields. reported_pubkey / reported_event_id / reporter_pubkey are
# identifiers osprey sets directly, not profile lookups, and are not built by this rule.
identifiers = {"reported_pubkey", "reported_event_id", "reporter_pubkey"}
print("\n".join(sorted(
    n for n in declared if n.startswith(prefixes) and n not in identifiers)))
' > "$WORK/coop.txt"

# --- compare --------------------------------------------------------------------------
if diff -u "$WORK/osprey.txt" "$WORK/coop.txt" > "$WORK/diff.txt"; then
  echo "OK: $(wc -l < "$WORK/osprey.txt" | tr -d ' ') profile fields, osprey ($REF) and coop agree exactly"
  exit 0
fi

echo "DRIFT: osprey ($REF) and coop declare different profile fields"
echo "  '-' = osprey emits it and Coop would DROP it (enrichment computed, moderator never sees it)"
echo "  '+' = Coop declares it and osprey never sends it (a permanently blank row on the card)"
sed 's/^/  /' "$WORK/diff.txt"
exit 1
