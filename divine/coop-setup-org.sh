#!/usr/bin/env bash
# coop-setup-org.sh — Reproducibly bootstrap a COOP org's moderation config
# (content type + review queues + routing + content rule + enforcement actions)
# to mirror relay-manager's queues.
#
# WHY THIS EXISTS: COOP org config (content types, queues, routing rules, actions)
# is runtime state in COOP's Postgres, NOT code — it does not travel between
# local/staging/prod and was never captured in any PR. This script is that missing
# seed. It is idempotent: it skips anything that already exists.
#
# Usage:
#   export COOP_API_URL=https://coop.staging.dvines.org
#   export COOP_LOGIN_EMAIL=matt@divine.video
#   export COOP_LOGIN_PASSWORD=...        # the org admin password
#   # For the enforcement actions (step 6) — point at the in-cluster adapter and
#   # supply the shared webhook secret (omit WEBHOOK_SECRET to skip step 6):
#   export COOP_ADAPTER_URL=http://coop-webhook-adapter:3456   # default
#   export WEBHOOK_SECRET=...             # MUST match the adapter's WEBHOOK_SECRET env
#   ./divine/coop-setup-org.sh
#
# Requires: curl, python3. The login user must be an org ADMIN (admin GraphQL
# mutations need a user session — the org API key is NOT sufficient). The built-in
# ENQUEUE_TO_MRT action must already be seeded (create-org-and-user.js does this).
set -euo pipefail

: "${COOP_API_URL:?Set COOP_API_URL (e.g. https://coop.staging.dvines.org)}"
: "${COOP_LOGIN_EMAIL:?Set COOP_LOGIN_EMAIL}"
: "${COOP_LOGIN_PASSWORD:?Set COOP_LOGIN_PASSWORD}"
COOP_ADAPTER_URL="${COOP_ADAPTER_URL:-http://coop-webhook-adapter:3456}"
GQL="${COOP_API_URL}/api/v1/graphql"
CJ=$(mktemp); trap 'rm -f "$CJ"' EXIT

gql() { # $1=query  $2=variables-json  -> raw response
  local q="$1" v="${2:-}"
  [ -z "$v" ] && v='{}'
  curl -sS -m 20 -b "$CJ" "$GQL" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"query":sys.argv[1],"variables":json.loads(sys.argv[2])}))' "$q" "$v")"
}

type_id() {
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); t=(((d.get("data") or {}).get("myOrg") or {}).get("itemTypes") or []); print(next((x["id"] for x in t if x.get("name")==sys.argv[2] and x.get("id")), ""))' "$TYPES" "$1"
}

echo "==> Logging in as $COOP_LOGIN_EMAIL"
curl -sS -m 15 -c "$CJ" "$GQL" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"query":"mutation L($i: LoginInput!){ login(input:$i){ __typename ... on LoginSuccessResponse { user { email role } } } }","variables":{"i":{"email":sys.argv[1],"password":sys.argv[2]}}}))' "$COOP_LOGIN_EMAIL" "$COOP_LOGIN_PASSWORD")" \
  | grep -q LoginSuccessResponse || { echo "ERROR: login failed"; exit 1; }

# ---------------------------------------------------------------------------
# 1) Content type: nostr_event — fields match osprey COOPSink's POST /api/v1/content
#    payload exactly (coop_sink.py). pubkeys are STRING (not USER_ID) because
#    COOPSink sends bare hex; createdAt is omitted as a field role because the
#    bridge sends unix seconds in created_at, not COOP's DATETIME role value.
# ---------------------------------------------------------------------------
echo "==> Ensuring content type 'nostr_event'"
# The Review Console is schema-driven: ManualReviewJobContentView zips the item
# type's baseFields against the item data and the renderer dispatches on each
# field's DECLARED TYPE, never its name. So a new field here renders to
# moderators automatically, with a humanised label and no client change. That is
# what makes carrying more context a config change rather than a UI fork.
#
# Field types are chosen for how they render: URL becomes a real hyperlink,
# VIDEO/IMAGE become players, STRING becomes a labelled row. A field whose value
# is null is dropped from the view entirely, so partially-populated items stay
# tidy rather than showing empty rows.
#
# NOT set here: the creatorId field role. It drives the Associated User panel and
# per-account actions, which need a User item type to resolve into. It belongs
# with that work, not with a bare pubkey string.
CT_FIELDS='[{"name":"event_id","type":"STRING","required":true},{"name":"source_event_id","type":"STRING","required":false},{"name":"pubkey","type":"STRING","required":false},{"name":"kind","type":"NUMBER","required":false},{"name":"created_at","type":"NUMBER","required":false},{"name":"verdict","type":"STRING","required":false},{"name":"action_name","type":"STRING","required":false},{"name":"report_reason","type":"STRING","required":false},{"name":"reported_pubkey","type":"STRING","required":false},{"name":"reported_event_id","type":"STRING","required":false},{"name":"label_value","type":"STRING","required":false},{"name":"label_namespace","type":"STRING","required":false},{"name":"text","type":"STRING","required":false},{"name":"media_url","type":"VIDEO","required":false},{"name":"media_thumbnail","type":"IMAGE","required":false},{"name":"media_sha256","type":"STRING","required":false},{"name":"reporter_pubkey","type":"STRING","required":false},{"name":"relay_manager_url","type":"URL","required":false}]'
CT_FIELD_ROLES='{"displayName":"text","creatorId":null,"threadId":null,"parentId":null,"createdAt":null,"isDeleted":null}'
TYPES=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }')
CT_ID=$(type_id nostr_event)
if [ -n "$CT_ID" ]; then
  # Reconcile in place. updateContentItemType REPLACES the schema with the array
  # given, and explicit null field roles clear stale live role assignments. Same
  # reconcile-not-skip approach the routing rules use (#12): a setup script that
  # skips existing objects silently drifts from the file that claims to define them.
  CT_VARS=$(printf '{"input":{"id":"%s","name":"nostr_event","description":"Divine Nostr event flagged by Osprey for moderator review","fields":%s,"fieldRoles":%s}}' "$CT_ID" "$CT_FIELDS" "$CT_FIELD_ROLES")
  RESP=$(gql 'mutation U($input: UpdateContentItemTypeInput!){ updateContentItemType(input:$input){ __typename } }' "$CT_VARS")
  if echo "$RESP" | grep -q '"__typename":"MutateContentTypeSuccessResponse"' && ! echo "$RESP" | grep -q '"errors"'; then
    echo "    exists, schema reconciled"
  else
    echo "    ERROR: content type update failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
else
  CT_VARS=$(printf '{"input":{"name":"nostr_event","description":"Divine Nostr event flagged by Osprey for moderator review","fields":%s,"fieldRoles":%s}}' "$CT_FIELDS" "$CT_FIELD_ROLES")
  RESP=$(gql 'mutation C($input: CreateContentItemTypeInput!){ createContentItemType(input:$input){ __typename } }' "$CT_VARS")
  # Decide from the typed response: success typename present AND no error typename / GraphQL errors.
  if echo "$RESP" | grep -q '"__typename":"MutateContentTypeSuccessResponse"' && ! echo "$RESP" | grep -q '"errors"'; then
    echo "    created"
  else
    echo "    ERROR: content type create failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 1b) User item type, keyed by pubkey.
#
# Needed before anything can use Coop's reporting API: POST /api/v1/report
# REQUIRES reporter{kind,typeId,id}, and typeId must name a User item type.
#
# It is also the single change that unlocks three things at once, because Coop
# keys per-account features off a User item: lookup by pubkey, an account's
# history, and bulk actions over a pasted pubkey list. Without it, Coop can only
# ever be searched by item id.
#
# displayName is the pubkey itself. We have no username to show, and a moderator
# recognises an npub; an empty display name renders as a blank row.
# ---------------------------------------------------------------------------
echo "==> Ensuring user type 'nostr_user'"
UT_FIELDS='[{"name":"pubkey","type":"STRING","required":true},{"name":"npub","type":"STRING","required":false},{"name":"first_seen_at","type":"DATETIME","required":false}]'
UT_ID=$(type_id nostr_user)
UT_EXISTS=false
if [ -n "$UT_ID" ]; then
  UT_EXISTS=true
  UT_VARS=$(printf '{"input":{"id":"%s","name":"nostr_user","description":"A Nostr account, keyed by pubkey","fields":%s,"fieldRoles":{"displayName":"pubkey","createdAt":null,"profileIcon":null,"backgroundImage":null,"isDeleted":null}}}' "$UT_ID" "$UT_FIELDS")
  RESP=$(gql 'mutation U($input: UpdateUserItemTypeInput!){ updateUserItemType(input:$input){ __typename ... on MutateUserTypeSuccessResponse { data { id } } } }' "$UT_VARS")
else
  UT_VARS=$(printf '{"input":{"name":"nostr_user","description":"A Nostr account, keyed by pubkey","fields":%s,"fieldRoles":{"displayName":"pubkey","createdAt":null,"profileIcon":null,"backgroundImage":null,"isDeleted":null}}}' "$UT_FIELDS")
  RESP=$(gql 'mutation C($input: CreateUserItemTypeInput!){ createUserItemType(input:$input){ __typename ... on MutateUserTypeSuccessResponse { data { id } } } }' "$UT_VARS")
fi
NEW_UT_ID=$(echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=(d.get("data") or {}).get("updateUserItemType") or (d.get("data") or {}).get("createUserItemType") or {}; print(((r.get("data") or {}).get("id")) or "")' 2>/dev/null || true)
# Coop's user item type mutations can answer with `data: null` inside a
# MutateUserTypeSuccessResponse: server/graphql/modules/itemType.ts returns the
# item type directly at createUserItemType/updateUserItemType, while the schema
# declares a { data: UserItemType } wrapper. Requiring an id from that response
# failed on a success and exited before provisioning any action, leaving the org
# half-configured with no indication that the work it exists to do had not run.
# Verified against staging: the type WAS created, twice, while this reported an error.
#
# So: trust the typename. Reuse the known id on update, and re-resolve the id by
# querying only after create. Remove this once the deployed server wraps
# MutateUserTypeSuccessResponse as { data: userItemType }.
if [ -z "$NEW_UT_ID" ] && echo "$RESP" | grep -q '"__typename":"MutateUserTypeSuccessResponse"'; then
  if [ "$UT_EXISTS" = true ]; then
    NEW_UT_ID="$UT_ID"
  else
    TYPES=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }')
    NEW_UT_ID=$(type_id nostr_user)
  fi
fi
if echo "$RESP" | grep -q '"__typename":"MutateUserTypeSuccessResponse"' && ! echo "$RESP" | grep -q '"errors"' && [ -n "$NEW_UT_ID" ]; then
  UT_ID="$NEW_UT_ID"
  if [ "$UT_EXISTS" = true ]; then echo "    reconciled"; else echo "    created"; fi
elif echo "$RESP" | grep -q '"__typename":"MutateUserTypeSuccessResponse"' && ! echo "$RESP" | grep -q '"errors"'; then
  echo "    ERROR: user type mutation succeeded but id could not be resolved: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
else
  echo "    ERROR: user type failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
fi
echo "    nostr_user typeId = $UT_ID  (COOPSink needs this as DIVINE_COOP_USER_TYPE_ID)"

# ---------------------------------------------------------------------------
# 2) Review queues — approximate relay-manager's category tiers (lib/constants.ts
#    CATEGORY_LABELS + HIGH_PRIORITY_CATEGORIES + ReportWatcher immediate/threshold).
#    The relay-manager category -> queue mapping is documented in
#    docs/moderation/coop-osprey-reportwatcher-migration.md.
# ---------------------------------------------------------------------------
# name|appeals|description
# CSAM, Child Safety, and Age Review are deliberately DISTINCT queues (not a
# combined tier): each gets its own handling. CSAM is sticky/one-way + NCMEC-bound;
# Child Safety is the broader child-safety triage; Age Review is the underage-user
# path that feeds the relay-manager age-review case system. Moderators can move a
# job between queues (transformJobAndRecreateInQueue) when a report needs recategorizing.
QUEUES=(
  "CSAM|false|report_reason 'csam'. Sticky/one-way; route to NCMEC. Keep undiluted by ambiguous reports."
  "Child Safety|false|report_reason 'child_safety' (divine-mobile childSafety). Child-safety concerns distinct from CSAM; a moderator escalates to CSAM/NCMEC if warranted."
  "Age Review|false|report_reason 'underage_user' (divine-mobile underageUser). Underage-user reports; feeds the relay-manager age-review case system (15-day clock, age tiers, suspension). See docs/moderation/under-16-system-coordination.md."
  "Sexual Content|false|report_reason 'nudity' (web sexual-content, mobile sexualContent + aliases). Age-restrict candidates."
  "Violence & Extremism|false|report_reason 'violence'."
  "Harassment, Threats & Safety|false|report_reason 'harassment'."
  "General Review|false|Default catch-all: spam, impersonation, copyright, false-info/other, ai_generated, illegal, malware."
  "Appeals|true|User appeals of moderation decisions."
)
echo "==> Ensuring review queues"
EXISTING_Q=$(gql 'query { myOrg { mrtQueues { id name } } }')
for row in "${QUEUES[@]}"; do
  NAME="${row%%|*}"; rest="${row#*|}"; APPEALS="${rest%%|*}"; DESC="${rest#*|}"
  if echo "$EXISTING_Q" | grep -qF "\"$NAME\""; then
    echo "    '$NAME' exists, skipping"
    continue
  fi
  QV=$(python3 -c 'import json,sys; print(json.dumps({"input":{"name":sys.argv[1],"description":sys.argv[2],"autoCloseJobs":False,"isAppealsQueue":sys.argv[3]=="true","hiddenActionIds":[],"userIds":[]}}))' "$NAME" "$DESC" "$APPEALS")
  RESP=$(gql 'mutation Q($input: CreateManualReviewQueueInput!){ createManualReviewQueue(input:$input){ __typename ... on MutateManualReviewQueueSuccessResponse { data { ... on ManualReviewQueue { id } } } } }' "$QV")
  NEWID=$(echo "$RESP" | python3 -c "import json,sys;q=json.load(sys.stdin)['data']['createManualReviewQueue'];print((q.get('data') or {}).get('id',''))" 2>/dev/null || true)
  if [ -n "$NEWID" ]; then
    echo "    '$NAME' -> $NEWID"
  else
    echo "    ERROR: queue create failed for '$NAME': $(echo "$RESP" | tr '\n' ' ' | head -c 300)"
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 3) Default routing rule: all nostr_event items -> General Review. This is the
#    catch-all fallback; the category-specific rules in step 5 are ordered ahead
#    of it (first-match-wins).
# ---------------------------------------------------------------------------
RULE_NAME="nostr_event -> General Review"
echo "==> Ensuring default routing rule ($RULE_NAME)"
# Idempotency: skip if the rule already exists (same pattern as steps 1 and 2).
EXISTING_R=$(gql 'query { myOrg { routingRules { id name } } }')
if echo "$EXISTING_R" | grep -qF "\"$RULE_NAME\""; then
  echo "    exists, skipping"
else
  TID=$(type_id nostr_event)
  if [ -z "$TID" ]; then
    TYPES=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }')
    TID=$(type_id nostr_event)
  fi
  GQID=$(gql 'query { myOrg { mrtQueues { id name } } }' | python3 -c "import json,sys;qs=json.load(sys.stdin)['data']['myOrg']['mrtQueues'];print(next((q['id'] for q in qs if q['name']=='General Review'),''))" 2>/dev/null || true)
  if [ -z "$TID" ] || [ -z "$GQID" ]; then
    echo "    ERROR: could not resolve nostr_event type ($TID) or General Review queue ($GQID)"; exit 1
  fi
  RV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"name":sys.argv[1],"conditionSet":{"conditions":[],"conjunction":"AND"},"destinationQueueId":sys.argv[2],"itemTypeIds":[sys.argv[3]],"status":"LIVE"}}))' "$RULE_NAME" "$GQID" "$TID")
  RESP=$(gql 'mutation R($input: CreateRoutingRuleInput!){ createRoutingRule(input:$input){ __typename } }' "$RV")
  if echo "$RESP" | grep -q '"__typename":"MutateRoutingRuleSuccessResponse"'; then
    echo "    created"
  elif echo "$RESP" | grep -q 'RoutingRuleNameExistsError'; then
    echo "    exists, skipping"
  else
    echo "    ERROR: routing rule create failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
fi

# --- Shared lookups for the rule/action steps below ----------------------------
TYPES=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }')
TID=$(type_id nostr_event)
[ -z "$TID" ] && { echo "ERROR: cannot resolve nostr_event content type id"; exit 1; }
QUEUES_JSON=$(gql 'query { myOrg { mrtQueues { id name } } }')
qid() { echo "$QUEUES_JSON" | python3 -c "import json,sys;qs=json.load(sys.stdin)['data']['myOrg']['mrtQueues'];print(next((q['id'] for q in qs if q['name']==sys.argv[1]),''))" "$1"; }

# ---------------------------------------------------------------------------
# 4) Content rule: enqueue every nostr_event to the MRT so items SURFACE as
#    review jobs. This is the piece that was missing (#159): without a content
#    rule firing the built-in ENQUEUE_TO_MRT action, submitted items never become
#    review jobs. COOPSink only posts already-actionable verdicts, so an
#    unconditional enqueue (empty conditionSet = match-all) is correct.
# ---------------------------------------------------------------------------
CONTENT_RULE_NAME="nostr_event -> review queue"
echo "==> Ensuring content rule ($CONTENT_RULE_NAME)"
# Idempotency by GUARANTEE, not mere existence. A content rule only satisfies #159
# if it TARGETS nostr_event, is status LIVE, AND fires the built-in EnqueueToMrtAction.
# A stale, disabled, or differently-actioned rule must NOT let us skip -- that would
# leave submitted items never becoming MRT jobs, the exact failure this step prevents.
# So: skip only if a satisfying rule exists; if our own rule exists but is not
# LIVE+enqueue, reconcile it in place; otherwise create.
EXISTING_CR=$(gql 'query { myOrg { rules { id name status ... on ContentRule { itemTypes { __typename ... on ItemTypeBase { name } } actions { __typename } } } } }')
CR_DECISION=$(echo "$EXISTING_CR" | python3 -c "
import json,sys
rs = json.load(sys.stdin)['data']['myOrg']['rules']
def targets(r): return any(t.get('name')=='nostr_event' for t in (r.get('itemTypes') or []))
def enqueues(r): return any(a.get('__typename')=='EnqueueToMrtAction' for a in (r.get('actions') or []))
satisfying = any(targets(r) and r.get('status')=='LIVE' and enqueues(r) for r in rs)
ours = next((r['id'] for r in rs if r.get('name')==sys.argv[1]), '')
print('satisfied|' if satisfying else ('reconcile|'+ours if ours else 'create|'))
" "$CONTENT_RULE_NAME" || echo 'create|')
CR_MODE="${CR_DECISION%%|*}"; OURS_ID="${CR_DECISION#*|}"
if [ "$CR_MODE" = "satisfied" ]; then
  echo "    a LIVE content rule already enqueues nostr_event to the MRT, skipping"
else
  # Both create and reconcile need the built-in enqueue action id.
  ENQUEUE_ID=$(gql 'query { myOrg { actions { __typename ... on ActionBase { id name } } } }' \
    | python3 -c "import json,sys;a=json.load(sys.stdin)['data']['myOrg']['actions'];print(next((x['id'] for x in a if x.get('__typename')=='EnqueueToMrtAction'),''))" 2>/dev/null || true)
  if [ -z "$ENQUEUE_ID" ]; then
    echo "    ERROR: no built-in ENQUEUE_TO_MRT action found — run create-org-and-user.js first."; exit 1
  fi
  if [ "$CR_MODE" = "reconcile" ]; then
    # Our rule exists but is stale/disabled/differently-actioned. Restore the
    # guarantee in place rather than skipping past it or duplicating it.
    UV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"id":sys.argv[1],"status":"LIVE","contentTypeIds":[sys.argv[2]],"actionIds":[sys.argv[3]],"conditionSet":{"conditions":[],"conjunction":"AND"}}}))' "$OURS_ID" "$TID" "$ENQUEUE_ID")
    RESP=$(gql 'mutation UCR($input: UpdateContentRuleInput!){ updateContentRule(input:$input){ __typename } }' "$UV")
    if echo "$RESP" | grep -q '"__typename":"MutateContentRuleSuccessResponse"'; then
      echo "    reconciled existing '$CONTENT_RULE_NAME' to LIVE + EnqueueToMrtAction"
    else
      echo "    ERROR: content rule reconcile failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
    fi
  else
    CRV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"name":sys.argv[1],"description":"Surface every Osprey-flagged nostr_event for moderator review","status":"LIVE","contentTypeIds":[sys.argv[2]],"conditionSet":{"conditions":[],"conjunction":"AND"},"actionIds":[sys.argv[3]],"policyIds":[],"tags":[]}}))' "$CONTENT_RULE_NAME" "$TID" "$ENQUEUE_ID")
    RESP=$(gql 'mutation CR($input: CreateContentRuleInput!){ createContentRule(input:$input){ __typename } }' "$CRV")
    if echo "$RESP" | grep -q '"__typename":"MutateContentRuleSuccessResponse"'; then
      echo "    created"
    elif echo "$RESP" | grep -q 'RuleNameExistsError'; then
      echo "    exists (created concurrently); re-run to reconcile it to LIVE+enqueue"
    else
      echo "    ERROR: content rule create failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5) Category routing rules: report_reason matches <canonical token> -> category queue.
#    First-match-wins by sequence, so CSAM is ordered FIRST (sticky, one-way, must
#    reach NCMEC — docs/moderation/moderation-category-handling-principles.md), then
#    Child Safety, Age Review, Sexual, Violence, Harassment, with General Review
#    ordered LAST in step 5b.
#
#    EXACT MATCH: report_reason holds a single canonical token, so each rule must
#    match that token EXACTLY. COOP exposes no equality signal (only CONTAINS_TEXT,
#    CONTAINS_REGEX, CONTAINS_VARIANT and their NOT forms), and plain CONTAINS_TEXT is
#    a substring test — 'not_csam' would match the CSAM route into the sticky, one-way,
#    NCMEC-bound queue. So we use TEXT_MATCHING_CONTAINS_REGEX with an anchored pattern
#    ^<token>$ (the signal compiles it case-insensitively). Tokens are [a-z_] only
#    (enforced by the guard below), so no regex escaping is needed.
#
#    Tokens are the canonical report_reason values from the bridge's CANONICAL_REASONS
#    (osprey divine/nostr-kafka-bridge/main.py), the single source of truth. Ownership
#    there decides what actually FEEDS each queue:
#      - csam, child_safety, nudity, violence, harassment are 'osprey-rule': Osprey
#        emits an actionable verdict, COOPSink posts it, so these routes fire on the
#        live path.
#      - underage_user is 'relay-manager': the bridge normalizes the token but Osprey
#        emits NO verdict for it (age review is owned by relay-manager ReportWatcher +
#        Zendesk, 15-day clock). So the Age Review queue is fed by the DIRECT bridge
#        import (coop-bridge-import.sh) and by moderators recategorizing, NOT by the
#        live Osprey path. The route is kept so those imported items land correctly.
#    Everything not routed below (spam, impersonation, ai_generated, illegal, other)
#    falls through to General Review for human triage. NB 'illegal' is deliberately NOT
#    routed to CSAM: mobile overloads it for CSAM, violence, AND copyright, so it is
#    ambiguous and must be human-triaged, not auto-classified into the CSAM/NCMEC queue.
# ---------------------------------------------------------------------------
# field|queue|comma-separated tokens. The field is the CONTENT_FIELD the rule matches.
#
# TWO FAMILIES, because an item carries EITHER a report_reason OR a label_value. A kind-1985
# classification from moderation-service has no report_reason at all, so before this every
# human-confirmed classification fell through every specialist rule into General Review --
# a ConfirmedCSAM label never reached the CSAM queue.
#
# NOT fixed here, and worth knowing: osprey's most severe verdict still does not route.
# PermanentBan fires on Kind in [34235, 34236] (ai_classification.sml) -- video events that
# carry NEITHER report_reason NOR label_value -- so those items land in General Review with
# verdict 'ban'. Routing them needs a third family keyed on `verdict`, not a label token.
#
# That disjointness is a property of the PRODUCERS, not something enforced here or by Coop:
# the bridge extracts label_* only for kind 1985 and report_reason only for kind 1984. Note
# COOPSink writes label_value UNCONDITIONALLY in its ai_detector_nsfw branch, so that is the
# one path that could ever submit an empty one. So cross-family ordering is not load-bearing TODAY. It
# would become load-bearing if any producer ever emitted both. The ordering below is chosen
# to survive that anyway -- both CSAM routes sit first -- but do not read it as a guarantee.
# What IS load-bearing regardless: CSAM first within each family (sticky, one-way,
# NCMEC-bound), and General Review last overall.
CATROUTES=(
  "report_reason|CSAM|csam"
  "report_reason|Child Safety|child_safety"
  "report_reason|Age Review|underage_user"
  "report_reason|Sexual Content|nudity"
  "report_reason|Violence & Extremism|violence"
  "report_reason|Harassment, Threats & Safety|harassment"
  "label_value|CSAM|csam,sexual_minors"
  "label_value|Sexual Content|nudity,sexual,explicit,pornography"
  "label_value|Violence & Extremism|violence,gore,graphic-violence"
)
# ai-generated and deepfake are deliberately NOT routed: General Review is the match-all
# catch-all, ordered last, and its remit already covers AI-generated content. They route
# correctly by falling through, so a rule would add config with no behaviour change.
# Guard: every routed token MUST be in the canonical vocabulary -- a subset of osprey's
# CANONICAL_REASONS (divine/nostr-kafka-bridge/main.py). Vendored here because coop and
# osprey share no runtime; this fails loud on drift (a typo, or a token Osprey can't
# emit) instead of silently provisioning a queue nothing can route to. Tokens are also
# constrained to [a-z_] so the anchored regex above needs no escaping.
CANONICAL_REASONS=" csam illegal child_safety harassment nudity violence ai_generated underage_user spam impersonation other "
# label_value is a SEPARATE vocabulary with a separate source of truth: the content-warning
# values matched by osprey divine/rules/rules/content/label_routing.sml. Validating label
# tokens against CANONICAL_REASONS would reject every one of them. Vendored for the same
# fail-loud-on-drift reason as above.
#
# SCOPE: this is the CONTENT-WARNING vocabulary only. `label_value` has a second producer --
# the ai_detector_nsfw path sets it from DetectorClass ('porn'/'sexy'/'hentai', defaulting to
# 'nsfw'), which shares NO tokens with the list below. Those items therefore fall through to
# General Review today. That is deliberate for now, not an oversight: the detector emits
# flag_for_review (machine evidence awaiting a human), and mixing machine suspicion into a
# specialist queue alongside human-confirmed classifications is a moderation-policy call, not
# a provisioning one. If that call is made, add the tokens here AND a route above.
_NL='
'
CANONICAL_LABEL_VALUES=" csam sexual_minors nudity sexual explicit pornography violence gore graphic-violence ai-generated deepfake "
for row in "${CATROUTES[@]}"; do
  _field="${row%%|*}"; _rest="${row#*|}"
  IFS=',' read -ra _toks <<< "${_rest#*|}"
  # Charset is per-field. report_reason tokens are [a-z_]; label_value tokens also contain
  # hyphens (ai-generated, graphic-violence). A hyphen is not a metacharacter in an anchored
  # ^token$ pattern, so it stays regex-safe; the vocabulary check below is the real guard.
  case "$_field" in
    report_reason) _vocab="$CANONICAL_REASONS"; _charset='^[a-z_]+$'; _srcname="osprey CANONICAL_REASONS" ;;
    label_value)   _vocab="$CANONICAL_LABEL_VALUES"; _charset='^[a-z_-]+$'; _srcname="osprey label_routing.sml" ;;
    *) echo "ERROR: route field '$_field' is not a known CONTENT_FIELD (expected report_reason or label_value)"; exit 1 ;;
  esac
  # The provisioner below splits with python `.split(",")`, which KEEPS empty fields;
  # bash's `read -ra` DROPS a trailing one. That divergence let "csam," pass this guard
  # while shipping the pattern ^$ -- which matches an EMPTY label_value and would route
  # blank-field items straight into CSAM. Reject malformed lists before tokenizing so the
  # two agree by construction.
  case "${_rest#*|}" in
    *"$_NL"*)
      echo "ERROR: route token list for '$_field -> ${_rest%%|*}' contains a newline (a wrapped array element); bash reads only the first line, so the guard would not see the rest"; exit 1 ;;
    ''|*,,*|,*|*,)
      echo "ERROR: route token list for '$_field -> ${_rest%%|*}' is malformed (empty, or a leading/trailing/double comma): '${_rest#*|}'"; exit 1 ;;
  esac
  for tok in "${_toks[@]}"; do
    if [[ ! "$tok" =~ $_charset ]]; then
      echo "ERROR: route token '$tok' does not match $_charset for field '$_field' (regex-unsafe / malformed)"; exit 1
    fi
    case "$_vocab" in
      *" $tok "*) ;;
      *) echo "ERROR: route token '$tok' is not in the canonical $_field vocabulary (drift vs $_srcname)"; exit 1 ;;
    esac
  done
done
echo "==> Ensuring category routing rules"
# Reconcile in place. A rule may already exist under our name but with a stale
# condition or destination from an earlier provisioning, and skip-by-name would
# leave it unhealed. So updateRoutingRule when the name exists and
# createRoutingRule when it doesn't, mirroring the content-rule reconcile in step
# 4. Idempotent: a rule already in the desired state is simply re-set to it.
EXISTING_R=$(gql 'query { myOrg { routingRules { id name } } }')
for row in "${CATROUTES[@]}"; do
  FIELD="${row%%|*}"; _rest="${row#*|}"; QUEUE="${_rest%%|*}"; KEYWORDS="${_rest#*|}"
  CR_NAME="$FIELD -> $QUEUE"
  QID=$(qid "$QUEUE")
  if [ -z "$QID" ]; then
    echo "    ERROR: queue '$QUEUE' not found (run step 2 first)"; exit 1
  fi
  # id of an existing rule with our name (empty if none)
  RID=$(echo "$EXISTING_R" | python3 -c '
import json,sys
payload=json.load(sys.stdin)
if payload.get("errors"):
    raise SystemExit("routingRules query returned errors: " + json.dumps(payload["errors"])[:300])
org=(payload.get("data") or {}).get("myOrg")
if not isinstance(org, dict) or not isinstance(org.get("routingRules"), list):
    raise SystemExit("routingRules query missing data.myOrg.routingRules")
print(next((r["id"] for r in org["routingRules"] if r.get("name")==sys.argv[1]), ""))' "$CR_NAME")
  # Desired input. Create and Update take the same fields; Update adds the id.
  # Anchored regex per token = exact match (COOP has no equality signal). The signal
  # compiles each string case-insensitively, so ^<token>$ matches the token exactly and
  # rejects substrings like not_csam. Tokens are [a-z_] (guarded), so no escaping needed.
  IN=$(RID="$RID" python3 -c '
import json,os,sys
tid,qid,name = sys.argv[1],sys.argv[2],sys.argv[3]
kw = ["^" + t + "$" for t in sys.argv[4].split(",")]
field = sys.argv[5]
cond = {"input":{"type":"CONTENT_FIELD","name":field,"contentTypeId":tid},
        "signal":{"id":json.dumps({"type":"TEXT_MATCHING_CONTAINS_REGEX"}),"type":"TEXT_MATCHING_CONTAINS_REGEX"},
        "matchingValues":{"strings":kw}}
inp = {"name":name,"conditionSet":{"conditions":[cond],"conjunction":"AND"},
       "destinationQueueId":qid,"itemTypeIds":[tid],"status":"LIVE"}
rid = os.environ.get("RID","")
if rid: inp["id"] = rid
print(json.dumps({"input":inp}))' "$TID" "$QID" "$CR_NAME" "$KEYWORDS" "$FIELD")
  if [ -n "$RID" ]; then
    RESP=$(gql 'mutation UR($input: UpdateRoutingRuleInput!){ updateRoutingRule(input:$input){ __typename } }' "$IN")
    ACT=reconciled
  else
    RESP=$(gql 'mutation CR($input: CreateRoutingRuleInput!){ createRoutingRule(input:$input){ __typename } }' "$IN")
    ACT=created
  fi
  if echo "$RESP" | grep -q '"__typename":"MutateRoutingRuleSuccessResponse"'; then
    echo "    $ACT '$CR_NAME' -> $QID"
  elif echo "$RESP" | grep -q 'RoutingRuleNameExistsError'; then
    if [ "$ACT" = "created" ]; then
      echo "    '$CR_NAME' created concurrently; re-run to reconcile it"
    else
      echo "    ERROR: routing rule reconcile failed for '$CR_NAME': another rule already has that name"; exit 1
    fi
  else
    echo "    ERROR: routing rule $ACT failed for '$CR_NAME': $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
done

echo "==> Ordering routing rules (CSAM first, General Review last)"
RR=$(gql 'query { myOrg { routingRules { id name } } }')
ORDER=$(echo "$RR" | python3 -c '
import json,sys
rules = json.load(sys.stdin)["data"]["myOrg"]["routingRules"]
by = {r["name"]: r["id"] for r in rules}
GENERAL = "nostr_event -> General Review"
# Category routes in priority order, WITHOUT the catch-all.
# The two families are disjoint (an item has report_reason XOR label_value), so their
# relative order cannot change any outcome. What IS load-bearing: CSAM first within each
# family, and General Review last overall (appended below).
priority = [
  "report_reason -> CSAM",
  "label_value -> CSAM",
  "report_reason -> Child Safety",
  "report_reason -> Age Review",
  "report_reason -> Sexual Content",
  "label_value -> Sexual Content",
  "report_reason -> Violence & Extremism",
  "label_value -> Violence & Extremism",
  "report_reason -> Harassment, Threats & Safety",
]
gen = by.get(GENERAL)
ordered = [by[n] for n in priority if n in by]
# Then any other rules (manually added / renamed) -- but never after the catch-all.
ordered += [r["id"] for r in rules if r["id"] not in ordered and r["id"] != gen]
# General Review LAST: it is a match-all (empty conditionSet) and routing is
# first-match-wins, so anything ordered after it can never fire.
if gen:
    ordered.append(gen)
print(json.dumps({"input":{"order":ordered}}))')
RESP=$(gql 'mutation RO($input: ReorderRoutingRulesInput!){ reorderRoutingRules(input:$input){ __typename } }' "$ORDER")
if echo "$RESP" | grep -q '"__typename":"MutateRoutingRulesOrderSuccessResponse"'; then
  echo "    ordered"
else
  echo "    ERROR: reorder failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
fi

# ---------------------------------------------------------------------------
# 6) Enforcement actions (CUSTOM_ACTION webhooks -> coop-webhook-adapter). Each
#    action POSTs to the adapter, which translates to relay-manager NIP-86
#    (ban/suspend/delete/hide/restore) or media moderation (age-restrict). The
#    adapter authenticates on the x-webhook-secret header, so WEBHOOK_SECRET here
#    MUST equal the adapter's WEBHOOK_SECRET env (GCP secret
#    coop-adapter-webhook-secret-ENVIRONMENT). The action NAME is the adapter
#    route: callbackUrl path /webhook/<name> must match the deployed adapter's route switch.
#    Idempotent + reconciling: existing actions are UPDATED with the current
#    callbackUrl + secret on every run, so rotating WEBHOOK_SECRET (or moving
#    COOP_ADAPTER_URL) is just a re-run. Skipped entirely if WEBHOOK_SECRET is unset.
# ---------------------------------------------------------------------------
if [ -z "${WEBHOOK_SECRET:-}" ]; then
  echo "==> WEBHOOK_SECRET unset — skipping enforcement actions (step 6)."
else
  echo "==> Ensuring enforcement actions (-> $COOP_ADAPTER_URL/webhook/<Action>)"
  # Un-Restrict-Media is the reversal for Age-Restrict. It sends SAFE, which maps
  # to Active in Blossom and so reverses AgeRestricted, Restricted and Banned
  # alike. Without it Coop could age-restrict media and never undo it, which also
  # meant an accepted appeal had no way to restore the content.
  ACTIONS_LIST=(Ban-User Suspend-User Unban-User Unsuspend-User Delete-Content Hide-Content Restore-Content Age-Restrict Un-Restrict-Media)
  UNRESTRICT_STATUS=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$COOP_ADAPTER_URL/webhook/Un-Restrict-Media" -H "Content-Type: application/json" -H "x-webhook-secret: __coop_setup_route_probe__" -d '{}' || true)
  if [ "$UNRESTRICT_STATUS" = "404" ] || [ "$UNRESTRICT_STATUS" = "000" ]; then
    echo "    WARNING: adapter route /webhook/Un-Restrict-Media is not available (HTTP $UNRESTRICT_STATUS); skipping that action."
    ACTIONS_LIST=(Ban-User Suspend-User Unban-User Unsuspend-User Delete-Content Hide-Content Restore-Content Age-Restrict)
  fi
  EXISTING_A=$(gql 'query { myOrg { actions { __typename ... on ActionBase { id name } } } }')
  for AN in "${ACTIONS_LIST[@]}"; do
    AID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); a=(((d.get("data") or {}).get("myOrg") or {}).get("actions") or []); print(next((x["id"] for x in a if x.get("name")==sys.argv[2] and x.get("id")), ""))' "$EXISTING_A" "$AN")
    if [ -n "$AID" ]; then
      # Update in place so a rotated WEBHOOK_SECRET (or a changed COOP_ADAPTER_URL)
      # actually propagates on re-run. Skipping would keep the OLD secret, and COOP
      # returns 202 to the moderator even when the adapter 401s the stale secret --
      # so enforcement would fail invisibly. Only the callback fields are sent;
      # name/description/itemTypeIds are left unchanged.
      UV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"id":sys.argv[1],"callbackUrl":sys.argv[2],"callbackUrlHeaders":{"x-webhook-secret":sys.argv[3]}}}))' "$AID" "$COOP_ADAPTER_URL/webhook/$AN" "$WEBHOOK_SECRET")
      RESP=$(gql 'mutation U($input: UpdateActionInput!){ updateAction(input:$input){ __typename } }' "$UV")
      if echo "$RESP" | grep -q '"__typename":"MutateActionSuccessResponse"'; then
        echo "    '$AN' updated (callbackUrl + webhook secret refreshed)"
      else
        echo "    ERROR: action update failed for '$AN': $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
      fi
      continue
    fi
    AV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"name":sys.argv[1],"description":"Divine enforcement via coop-webhook-adapter","itemTypeIds":[sys.argv[2]],"callbackUrl":sys.argv[3],"callbackUrlHeaders":{"x-webhook-secret":sys.argv[4]}}}))' "$AN" "$TID" "$COOP_ADAPTER_URL/webhook/$AN" "$WEBHOOK_SECRET")
    RESP=$(gql 'mutation A($input: CreateActionInput!){ createAction(input:$input){ __typename } }' "$AV")
    if echo "$RESP" | grep -q '"__typename":"MutateActionSuccessResponse"'; then
      echo "    '$AN' created"
    elif echo "$RESP" | grep -q 'ActionNameExistsError'; then
      echo "    '$AN' exists (created concurrently); re-run to refresh its secret"
    else
      echo "    ERROR: action create failed for '$AN': $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
    fi
  done
fi

echo "==> Done. Content type, queues, content rule, category routing, and"
echo "    enforcement actions are provisioned. Items surface in the COOP Review"
echo "    Console once the ItemProcessingWorker (Scylla) is live; moderator"
echo "    actions reach the relay/media stores via the deployed coop-webhook-adapter."
