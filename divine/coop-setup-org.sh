#!/usr/bin/env bash
# coop-setup-org.sh — Reproducibly bootstrap a COOP org's moderation config
# (content type + review queues + routing) to mirror relay-manager's queues.
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
#   ./scripts/coop-setup-org.sh
#
# Requires: curl, python3. The login user must be an org ADMIN (admin GraphQL
# mutations need a user session — the org API key is NOT sufficient).
set -euo pipefail

: "${COOP_API_URL:?Set COOP_API_URL (e.g. https://coop.staging.dvines.org)}"
: "${COOP_LOGIN_EMAIL:?Set COOP_LOGIN_EMAIL}"
: "${COOP_LOGIN_PASSWORD:?Set COOP_LOGIN_PASSWORD}"
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
#    COOPSink sends bare hex; the createdAt role is omitted (it requires a
#    DATETIME field per the valid_field_role_field_type DB constraint).
# ---------------------------------------------------------------------------
echo "==> Ensuring content type 'nostr_event'"
TYPES=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }')
if echo "$TYPES" | grep -q '"name": "nostr_event"' || echo "$TYPES" | grep -q '"name":"nostr_event"'; then
  echo "    exists, skipping"
else
  CT_VARS='{"input":{"name":"nostr_event","description":"Divine Nostr event flagged by Osprey for moderator review","fields":[{"name":"event_id","type":"STRING","required":true},{"name":"source_event_id","type":"STRING","required":false},{"name":"pubkey","type":"STRING","required":false},{"name":"kind","type":"NUMBER","required":false},{"name":"created_at","type":"NUMBER","required":false},{"name":"verdict","type":"STRING","required":false},{"name":"action_name","type":"STRING","required":false},{"name":"report_reason","type":"STRING","required":false},{"name":"reported_pubkey","type":"STRING","required":false},{"name":"reported_event_id","type":"STRING","required":false},{"name":"label_value","type":"STRING","required":false},{"name":"label_namespace","type":"STRING","required":false},{"name":"text","type":"STRING","required":false},{"name":"media_url","type":"VIDEO","required":false},{"name":"media_thumbnail","type":"IMAGE","required":false}],"fieldRoles":{"displayName":"text"}}}'
  gql 'mutation C($input: CreateContentItemTypeInput!){ createContentItemType(input:$input){ __typename } }' "$CT_VARS" | grep -q Success && echo "    created" || echo "    (create returned non-success; check manually)"
fi

# ---------------------------------------------------------------------------
# 2) Review queues — approximate relay-manager's category tiers (lib/constants.ts
#    CATEGORY_LABELS + HIGH_PRIORITY_CATEGORIES + ReportWatcher immediate/threshold).
#    The relay-manager category -> queue mapping is documented in
#    docs/moderation/coop-osprey-reportwatcher-migration.md.
# ---------------------------------------------------------------------------
# name|appeals|description
QUEUES=(
  "CSAM / Child Safety|false|Immediate-tier: sexual_minors, csam, NS-csam, NS-childSafety, NS-underageUser. Route to NCMEC."
  "Sexual Content|false|NS-sexualContent, adult_nudity, explicit_sex, pornography, nudity, nonconsensual_sexual_content. Age-restrict candidates."
  "Violence & Extremism|false|NS-violence, graphic_violence_gore, terrorism_extremism, credible_threats, NS-extremism."
  "Harassment, Threats & Safety|false|NS-harassment, hate_harassment, bullying_abuse, self_harm_suicide, doxxing_pii, credible_threats."
  "General Review|false|spam, impersonation, copyright, misinformation, AI generated, illegal_goods, malware_scam, NS-other."
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
  echo "    '$NAME' -> ${NEWID:-FAILED ($(echo "$RESP" | head -c 120))}"
done

# ---------------------------------------------------------------------------
# 3) Default routing rule: all nostr_event items -> General Review.
#    Category-specific routing (report_reason -> the queues above) needs a
#    conditionSet per queue and is left as a documented follow-up; it also
#    requires the ItemProcessingWorker to be running (Scylla — see migration doc).
# ---------------------------------------------------------------------------
echo "==> Ensuring default routing rule (nostr_event -> General Review)"
TID=$(gql 'query { myOrg { itemTypes { __typename ... on ItemTypeBase { id name } } } }' | python3 -c "import json,sys;ts=json.load(sys.stdin)['data']['myOrg']['itemTypes'];print(next((t['id'] for t in ts if t.get('name')=='nostr_event'),''))" 2>/dev/null || true)
GQID=$(gql 'query { myOrg { mrtQueues { id name } } }' | python3 -c "import json,sys;qs=json.load(sys.stdin)['data']['myOrg']['mrtQueues'];print(next((q['id'] for q in qs if q['name']=='General Review'),''))" 2>/dev/null || true)
if [ -n "$TID" ] && [ -n "$GQID" ]; then
  RV=$(python3 -c 'import json,sys;print(json.dumps({"input":{"name":"nostr_event -> General Review","conditionSet":{"conditions":[],"conjunction":"AND"},"destinationQueueId":sys.argv[1],"itemTypeIds":[sys.argv[2]],"status":"LIVE"}}))' "$GQID" "$TID")
  gql 'mutation R($input: CreateRoutingRuleInput!){ createRoutingRule(input:$input){ __typename } }' "$RV" | grep -q Success && echo "    created/ok" || echo "    (already exists or failed; check)"
fi

echo "==> Done. Queues visible in COOP Review Console. NOTE: items only surface"
echo "    once the ItemProcessingWorker runs (currently Scylla-blocked)."
