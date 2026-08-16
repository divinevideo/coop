#!/usr/bin/env bash
# Cross-repo drift check: do the profile fields coop DECLARES match the ones osprey EMITS?
#
# coop-setup-org.sh derives its profile fields from a prefix x suffix rule, and
# divine/test-coop-setup-guards.sh pins that derivation. But a pin only proves coop is
# self-consistent. It cannot prove coop agrees with the OTHER repo, and the two share no
# runtime, so nothing in either CI can notice them diverging. That is the same reason
# CANONICAL_REASONS is vendored with a fail-loud guard rather than imported.
#
# This closes that gap on demand. It does not run in CI, because CI has no osprey checkout;
# run it when either side's field list changes, and before provisioning a new org.
#
# WHAT IT COMPARES, and why it is the rules rather than only the output:
#   - osprey's SUFFIXES, read from coop_profile.py by AST (every f'{prefix}_...' key).
#   - osprey's PREFIXES, read from coop_sink.py by AST (the profile_subjects list, which
#     is where the subject list actually lives -- `reporter` is appended only for reports).
#   - coop's PROFILE_PREFIXES / PROFILE_SUFFIX_TYPES, read from the shipped setup script.
#   - coop's actual CT_FIELDS, so a correct rule whose output never reaches the artifact
#     is still caught.
# Comparing only the emitted key sets would be blind to a prefix added on ONE side, since
# each side's filter would quietly exclude the other's. Comparing the rules is not.
#
# It also EXECUTES osprey's builder over a corpus of cases, and cross-checks that execution
# against the AST. A grep sees the keys a developer typed; a run sees the keys a moderator
# gets. Where they disagree -- a key built under a condition the corpus does not hit -- the
# corpus is the thing at fault, and this says so rather than certifying a false OK.
#
# Usage: divine/check-profile-field-parity.sh [path-to-osprey] [git-ref]
#   defaults: ../osprey (relative to the COOP REPO ROOT, not your shell), origin/main
set -euo pipefail

# Resolve before cd, so a path relative to the caller's shell still works.
OSPREY_IN="${1:-}"
[ -n "$OSPREY_IN" ] && OSPREY_ABS="$(cd "$OSPREY_IN" 2>/dev/null && pwd || echo "$OSPREY_IN")"

cd "$(dirname "$0")/.."
OSPREY="${OSPREY_ABS:-../osprey}"
REF="${2:-origin/main}"
SRC=divine/coop-setup-org.sh

[ -d "$OSPREY/.git" ] || { echo "ERROR: no osprey checkout at '$OSPREY' (pass the path as \$1)"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# --- osprey side ----------------------------------------------------------------------
# Read from a git ref, not the working tree: an uncommitted local edit would make this
# report parity that no deployed image has.
for f in coop_profile.py services/coop_sink.py; do
  mkdir -p "$WORK/osprey/$(dirname "$f")"
  git -C "$OSPREY" show "$REF:divine/plugins/src/$f" > "$WORK/osprey/$f" 2>/dev/null || {
    echo "ERROR: $REF:divine/plugins/src/$f not found in $OSPREY"; exit 1; }
done

# --- coop side ------------------------------------------------------------------------
# Evaluate the SHIPPED assignment, so this checks the artifact provisioned to Coop rather
# than a copy of it. Both guards, matching test-coop-setup-guards.sh: without the second,
# a deleted end-marker makes awk run to EOF and this would source the whole setup script,
# provisioning mutations included.
awk '/^CT_FIELDS=/{f=1} f{print} f && /^# --- end field declaration/{exit}' "$SRC" > "$WORK/fields.sh"
grep -q '^profile_fields_json()' "$WORK/fields.sh" || { echo "ERROR: field declaration not captured from $SRC"; exit 1; }
grep -q 'end field declaration'  "$WORK/fields.sh" || { echo "ERROR: field declaration range never terminated in $SRC (missing end marker)"; exit 1; }

# shellcheck disable=SC1090
( set -euo pipefail; . "$WORK/fields.sh"
  printf '%s\n' "$PROFILE_PREFIXES" > "$WORK/coop_prefixes.txt"
  printf '%s\n' "$PROFILE_SUFFIX_TYPES" > "$WORK/coop_suffixes.txt"
  printf '%s'   "$CT_FIELDS" > "$WORK/coop_ct_fields.json" )

python3 - "$WORK" "$REF" <<'PY'
import ast, json, pathlib, sys

work = pathlib.Path(sys.argv[1]); ref = sys.argv[2]
sys.path.insert(0, str(work / 'osprey'))

profile_src = (work / 'osprey' / 'coop_profile.py').read_text()
sink_src = (work / 'osprey' / 'services' / 'coop_sink.py').read_text()

# --- osprey suffixes, by AST: every out[f'{prefix}_<literal>'] key ---------------------
suffixes = set()
for node in ast.walk(ast.parse(profile_src)):
    if not isinstance(node, ast.JoinedStr):
        continue
    vals = node.values
    if (len(vals) == 2
            and isinstance(vals[0], ast.FormattedValue)
            and isinstance(vals[0].value, ast.Name) and vals[0].value.id == 'prefix'
            and isinstance(vals[1], ast.Constant) and isinstance(vals[1].value, str)
            and vals[1].value.startswith('_')):
        suffixes.add(vals[1].value[1:])

# --- osprey prefixes, by AST: the profile_subjects list plus its appends ---------------
prefixes = set()


def _first_str(elt):
    if isinstance(elt, ast.Tuple) and elt.elts and isinstance(elt.elts[0], ast.Constant):
        v = elt.elts[0].value
        return v if isinstance(v, str) else None
    return None


for node in ast.walk(ast.parse(sink_src)):
    if (isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'profile_subjects' for t in node.targets)
            and isinstance(node.value, ast.List)):
        for elt in node.value.elts:
            if (s := _first_str(elt)):
                prefixes.add(s)
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'append'
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == 'profile_subjects'
            and node.args and (s := _first_str(node.args[0]))):
        prefixes.add(s)

fail = []
if not suffixes:
    fail.append("could not read any suffix from coop_profile.py -- the f-string shape changed")
if not prefixes:
    fail.append("could not read any prefix from coop_sink.py -- the profile_subjects shape changed")
if fail:
    print("ERROR: " + "; ".join(fail)); raise SystemExit(2)

# --- execute the builder, and hold the run against the AST -----------------------------
# The corpus is hand-maintained, so it is the thing most likely to be wrong. If the AST
# knows a suffix the run never produced, the corpus does not cover that branch and any
# "agree exactly" would be unearned.
import coop_profile as cp

CASES = [
    None,                                                     # lookup failed
    {},                                                       # no profile
    {'has_vanish_request': True},                             # vanish request, no profile
    {'profile': {'display_name': 'Sam'}, 'social': {'follower_count': 5}},
    {'profile': {'name': 'fallback', 'nip05': 'a@b.c', 'nip05_verified': True},
     'social': {'follower_count': 0}, 'has_vanish_request': True},
    {'profile': {'nip05': 'x@y.z', 'nip05_verified': False}, 'social': {}},
]
executed = set()
for prefix in sorted(prefixes):
    for case in CASES:
        executed |= set(cp.profile_fields(case, prefix=prefix, error='e'))

expected = {f'{p}_{s}' for p in prefixes for s in suffixes}
uncovered = sorted({s for s in suffixes
                    if not any(f'{p}_{s}' in executed for p in prefixes)})
if uncovered:
    print(f"ERROR: the case corpus never exercises these osprey keys: {uncovered}")
    print("       Add a case to CASES that reaches them; until then this check cannot")
    print("       certify parity for those fields.")
    raise SystemExit(2)

# --- coop side -------------------------------------------------------------------------
coop_prefixes = set((work / 'coop_prefixes.txt').read_text().split())
coop_suffixes = {st.split(':', 1)[0] for st in (work / 'coop_suffixes.txt').read_text().split()}
declared = {f['name'] for f in json.loads((work / 'coop_ct_fields.json').read_text())}

# Identifiers osprey sets directly; not built by the prefix x suffix rule. `author` is the
# RELATED_ITEM the Associated User panel resolves through -- it collides with the `author`
# PREFIX and is not an enrichment field.
IDENTIFIERS = {'author', 'reported_pubkey', 'reported_event_id', 'reporter_pubkey'}
# Filtered by the UNION of both sides' prefixes, so a prefix present on only one side is
# still visible. Filtering by one side's list is what would hide it.
all_prefixes = prefixes | coop_prefixes
declared_profile = {n for n in declared
                    if n.split('_')[0] in all_prefixes and n not in IDENTIFIERS}

problems = []
if prefixes != coop_prefixes:
    problems.append(f"PREFIX rule differs: osprey {sorted(prefixes)} vs coop {sorted(coop_prefixes)}")
if suffixes != coop_suffixes:
    problems.append(f"SUFFIX rule differs: osprey {sorted(suffixes)} vs coop {sorted(coop_suffixes)}")

missing = sorted(expected - declared_profile)   # osprey sends it, Coop drops it
extra = sorted(declared_profile - expected)     # Coop declares it, osprey never sends it
if missing:
    problems.append("osprey emits but Coop DROPS (enrichment computed, moderator never "
                    f"sees it): {missing}")
if extra:
    problems.append(f"Coop declares but osprey never sends (permanently blank row): {extra}")

if problems:
    print(f"DRIFT: osprey ({ref}) and coop disagree")
    for p in problems:
        print(f"  - {p}")
    raise SystemExit(1)

print(f"OK: {len(expected)} profile fields "
      f"({len(prefixes)} prefixes x {len(suffixes)} suffixes), osprey ({ref}) and coop "
      f"agree on the rule AND on the shipped field list")
PY
