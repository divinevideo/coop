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
TYPES=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }')
if echo "$TYPES" | grep -q '"name": "nostr_event"' || echo "$TYPES" | grep -q '"name":"nostr_event"'; then
  echo "    exists, skipping"
else
  CT_VARS='{"input":{"name":"nostr_event","description":"Divine Nostr event flagged by Osprey for moderator review","fields":[{"name":"event_id","type":"STRING","required":true},{"name":"source_event_id","type":"STRING","required":false},{"name":"pubkey","type":"STRING","required":false},{"name":"kind","type":"NUMBER","required":false},{"name":"created_at","type":"NUMBER","required":false},{"name":"verdict","type":"STRING","required":false},{"name":"action_name","type":"STRING","required":false},{"name":"report_reason","type":"STRING","required":false},{"name":"reported_pubkey","type":"STRING","required":false},{"name":"reported_event_id","type":"STRING","required":false},{"name":"label_value","type":"STRING","required":false},{"name":"label_namespace","type":"STRING","required":false},{"name":"text","type":"STRING","required":false},{"name":"media_url","type":"VIDEO","required":false},{"name":"media_thumbnail","type":"IMAGE","required":false}],"fieldRoles":{"displayName":"text"}}}'
  RESP=$(gql 'mutation C($input: CreateContentItemTypeInput!){ createContentItemType(input:$input){ __typename } }' "$CT_VARS")
  # Decide from the typed response: success typename present AND no error typename / GraphQL errors.
  if echo "$RESP" | grep -q '"__typename":"MutateContentTypeSuccessResponse"' && ! echo "$RESP" | grep -q '"errors"'; then
    echo "    created"
  else
    echo "    ERROR: content type create failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
fi

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
  TID=$(echo "$TYPES" | python3 -c "import json,sys;ts=json.load(sys.stdin)['data']['myOrg']['itemTypes'];print(next((t['id'] for t in ts if t.get('name')=='nostr_event'),''))" 2>/dev/null || true)
  [ -z "$TID" ] && TID=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }' | python3 -c "import json,sys;ts=json.load(sys.stdin)['data']['myOrg']['itemTypes'];print(next((t['id'] for t in ts if t.get('name')=='nostr_event'),''))" 2>/dev/null || true)
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
TID=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }' \
  | python3 -c "import json,sys;ts=json.load(sys.stdin)['data']['myOrg']['itemTypes'];print(next((t['id'] for t in ts if t.get('name')=='nostr_event'),''))" 2>/dev/null || true)
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
# Idempotency by TARGET, not name: skip if ANY content rule already targets
# nostr_event. Matching on our name alone would create a second always-match rule
# (double-enqueue) when a content rule exists under a different name.
EXISTING_CR=$(gql 'query { myOrg { rules { id name status ... on ContentRule { itemTypes { __typename ... on ItemTypeBase { name } } } } } }')
HAS_CR=$(echo "$EXISTING_CR" | python3 -c "import json,sys;rs=json.load(sys.stdin)['data']['myOrg']['rules'];print('yes' if any(any(t.get('name')=='nostr_event' for t in (r.get('itemTypes') or [])) for r in rs) else 'no')" 2>/dev/null || echo no)
if [ "$HAS_CR" = "yes" ]; then
  echo "    a content rule already targets nostr_event, skipping"
else
  ENQUEUE_ID=$(gql 'query { myOrg { actions { __typename ... on ActionBase { id name } } } }' \
    | python3 -c "import json,sys;a=json.load(sys.stdin)['data']['myOrg']['actions'];print(next((x['id'] for x in a if x.get('__typename')=='EnqueueToMrtAction'),''))" 2>/dev/null || true)
  if [ -z "$ENQUEUE_ID" ]; then
    echo "    ERROR: no built-in ENQUEUE_TO_MRT action found — run create-org-and-user.js first."; exit 1
  fi
  CRV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"name":sys.argv[1],"description":"Surface every Osprey-flagged nostr_event for moderator review","status":"LIVE","contentTypeIds":[sys.argv[2]],"conditionSet":{"conditions":[],"conjunction":"AND"},"actionIds":[sys.argv[3]],"policyIds":[],"tags":[]}}))' "$CONTENT_RULE_NAME" "$TID" "$ENQUEUE_ID")
  RESP=$(gql 'mutation CR($input: CreateContentRuleInput!){ createContentRule(input:$input){ __typename } }' "$CRV")
  if echo "$RESP" | grep -q '"__typename":"MutateContentRuleSuccessResponse"'; then
    echo "    created"
  else
    echo "    ERROR: content rule create failed: $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 5) Category routing rules: report_reason == <canonical value> -> category queue.
#    First-match-wins by sequence, so CSAM is ordered FIRST (sticky, one-way, must
#    reach NCMEC — docs/moderation/moderation-category-handling-principles.md),
#    then Sexual, Violence, Harassment, with the General Review default last.
#    Condition is the proven TEXT_MATCHING_CONTAINS_TEXT form (case-insensitive,
#    boolean passthrough — NO comparator/threshold; signal id is a JSON string per
#    JsonOf<SignalId>).
#
#    The match values are the EXACT canonical report_reason tokens Osprey emits.
#    The bridge's _normalize_report_reason (divine/nostr-kafka-bridge/main.py) maps
#    every raw report tag / MOD l-tag to one of: csam, child_safety, underage_user,
#    nudity, violence, harassment, spam, ai_generated, other (plus pass-through
#    NIP-56 types illegal, malware, impersonation). So the value is always a single
#    token, not free text — match the token, not fuzzy substrings. Everything not
#    routed below (spam, other, ai_generated, illegal, malware, impersonation)
#    intentionally falls through to General Review for human triage. NB 'illegal' is
#    deliberately NOT routed to CSAM: mobile sends it for CSAM, violence, AND
#    copyright, so it is ambiguous and must be triaged by a human rather than
#    auto-classified into the CSAM/NCMEC queue.
# ---------------------------------------------------------------------------
# queue|comma-separated report_reason tokens (canonical, from _normalize_report_reason)
CATROUTES=(
  "CSAM|csam"
  "Child Safety|child_safety"
  "Age Review|underage_user"
  "Sexual Content|nudity"
  "Violence & Extremism|violence"
  "Harassment, Threats & Safety|harassment"
)
echo "==> Ensuring category routing rules"
EXISTING_R=$(gql 'query { myOrg { routingRules { id name } } }')
for row in "${CATROUTES[@]}"; do
  QUEUE="${row%%|*}"; KEYWORDS="${row#*|}"
  CR_NAME="report_reason -> $QUEUE"
  if echo "$EXISTING_R" | grep -qF "\"$CR_NAME\""; then
    echo "    '$CR_NAME' exists, skipping"
    continue
  fi
  QID=$(qid "$QUEUE")
  if [ -z "$QID" ]; then
    echo "    ERROR: queue '$QUEUE' not found (run step 2 first)"; exit 1
  fi
  RV=$(python3 -c '
import json,sys
tid,qid,name,kw = sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4].split(",")
cond = {"input":{"type":"CONTENT_FIELD","name":"report_reason","contentTypeId":tid},
        "signal":{"id":json.dumps({"type":"TEXT_MATCHING_CONTAINS_TEXT"}),"type":"TEXT_MATCHING_CONTAINS_TEXT"},
        "matchingValues":{"strings":kw}}
print(json.dumps({"input":{"name":name,"conditionSet":{"conditions":[cond],"conjunction":"AND"},
                           "destinationQueueId":qid,"itemTypeIds":[tid],"status":"LIVE"}}))' "$TID" "$QID" "$CR_NAME" "$KEYWORDS")
  RESP=$(gql 'mutation R($input: CreateRoutingRuleInput!){ createRoutingRule(input:$input){ __typename } }' "$RV")
  if echo "$RESP" | grep -q '"__typename":"MutateRoutingRuleSuccessResponse"'; then
    echo "    '$CR_NAME' -> $QID"
  elif echo "$RESP" | grep -q 'RoutingRuleNameExistsError'; then
    echo "    '$CR_NAME' exists, skipping"
  else
    echo "    ERROR: routing rule create failed for '$CR_NAME': $(echo "$RESP" | tr '\n' ' ' | head -c 300)"; exit 1
  fi
done

echo "==> Ordering routing rules (CSAM first, General Review last)"
RR=$(gql 'query { myOrg { routingRules { id name } } }')
ORDER=$(echo "$RR" | python3 -c '
import json,sys
rules = json.load(sys.stdin)["data"]["myOrg"]["routingRules"]
by = {r["name"]: r["id"] for r in rules}
priority = [
  "report_reason -> CSAM",
  "report_reason -> Child Safety",
  "report_reason -> Age Review",
  "report_reason -> Sexual Content",
  "report_reason -> Violence & Extremism",
  "report_reason -> Harassment, Threats & Safety",
  "nostr_event -> General Review",
]
ordered = [by[n] for n in priority if n in by]
ordered += [r["id"] for r in rules if r["id"] not in ordered]   # any others, tail
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
#    route: callbackUrl path /webhook/<name> must match adapter.mjs's switch.
#    Idempotent + reconciling: existing actions are UPDATED with the current
#    callbackUrl + secret on every run, so rotating WEBHOOK_SECRET (or moving
#    COOP_ADAPTER_URL) is just a re-run. Skipped entirely if WEBHOOK_SECRET is unset.
# ---------------------------------------------------------------------------
if [ -z "${WEBHOOK_SECRET:-}" ]; then
  echo "==> WEBHOOK_SECRET unset — skipping enforcement actions (step 6)."
else
  echo "==> Ensuring enforcement actions (-> $COOP_ADAPTER_URL/webhook/<Action>)"
  ACTIONS_LIST=(Ban-User Suspend-User Unban-User Unsuspend-User Delete-Content Hide-Content Restore-Content Age-Restrict)
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
