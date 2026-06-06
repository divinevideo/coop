#!/usr/bin/env bash
# Configure COOP CUSTOM_ACTION webhooks to point at the enforcement adapter.
# The adapter translates COOP's webhook format to relay-manager NIP-86 RPC.
# ADAPTER_URL_BASE must be reachable from the COOP server/worker that executes
# the webhook. For a local COOP instance, http://localhost:3456 is fine.
# Usage: source .env.demo && ./divine/coop-configure-webhooks.sh
set -euo pipefail

: "${ADMIN_API_KEY:?Set ADMIN_API_KEY in .env.demo}"
: "${CF_ACCESS_CLIENT_ID:?Set CF_ACCESS_CLIENT_ID in .env.demo}"
: "${CF_ACCESS_CLIENT_SECRET:?Set CF_ACCESS_CLIENT_SECRET in .env.demo}"
: "${COOP_API_URL:?Set COOP_API_URL in .env.demo}"
: "${COOP_EMAIL:?Set COOP_EMAIL in .env.demo}"
: "${COOP_PASSWORD:?Set COOP_PASSWORD in .env.demo}"
: "${ADAPTER_URL_BASE:?Set ADAPTER_URL_BASE to the adapter URL reachable from COOP (e.g. http://localhost:3456 for local COOP)}"

# We need a session cookie from COOP for GraphQL
ADAPTER_URL_BASE="${ADAPTER_URL_BASE%/}"
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

echo "==> Logging into COOP..."
LOGIN_RESP=$(curl -s -c "$COOKIE_JAR" \
  -X POST "${COOP_API_URL}/api/v1/graphql" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg email "$COOP_EMAIL" --arg pw "$COOP_PASSWORD" '{
    "query": "mutation Login($input: LoginInput!) { login(input: $input) { ... on LoginSuccessResponse { user { email } } ... on LoginUserDoesNotExistError { title } ... on LoginIncorrectPasswordError { title } } }",
    "variables": {"input": {"email": $email, "password": $pw}}
  }')")

LOGIN_USER=$(echo "$LOGIN_RESP" | jq -r '.data.login.user.email // empty')
if [ -z "$LOGIN_USER" ]; then
  echo "ERROR: COOP login failed"
  echo "$LOGIN_RESP" | jq .
  exit 1
fi
echo "  Logged in as $LOGIN_USER"

echo ""
echo "==> Fetching existing actions..."
ACTIONS_RESP=$(curl -s -b "$COOKIE_JAR" \
  -X POST "${COOP_API_URL}/api/v1/graphql" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { myOrg { actions { ... on CustomAction { id name callbackUrl callbackUrlHeaders } ... on EnqueueToMrtAction { id name } ... on EnqueueToNcmecAction { id name } ... on EnqueueAuthorToMrtAction { id name } } } }"
  }')

echo "$ACTIONS_RESP" | jq '.data.myOrg.actions[] | select(.callbackUrl) | {id, name, callbackUrl}' 2>/dev/null || {
  echo "ERROR: Could not fetch actions"
  echo "$ACTIONS_RESP"
  exit 1
}

# Auth headers that COOP will send with every webhook call
AUTH_HEADERS=$(jq -n \
  --arg adminKey "$ADMIN_API_KEY" \
  --arg cfId "$CF_ACCESS_CLIENT_ID" \
  --arg cfSecret "$CF_ACCESS_CLIENT_SECRET" \
  '{
    "X-Admin-Key": $adminKey,
    "CF-Access-Client-Id": $cfId,
    "CF-Access-Client-Secret": $cfSecret
  }')

echo ""
echo "==> Updating action webhook URLs..."

# Map action names to relay-manager RPC methods
# The webhook body template uses COOP's custom body field to pass the RPC method and params.
# COOP sends: { item, policies, rules, action, custom: {...callbackUrlBody, ...mrtParams}, actorEmail }
# But relay-manager expects: { method, params }
# So we can't call /api/relay-rpc directly from COOP's webhook format.
#
# Instead, point COOP at a thin adapter endpoint that receives COOP's webhook
# and translates it to relay-manager RPC format.

# Filter to only CustomActions (those with callbackUrl)
ACTIONS=$(echo "$ACTIONS_RESP" | jq -c '[.data.myOrg.actions[] | select(.callbackUrl)]' 2>/dev/null)
ACTION_COUNT=$(echo "$ACTIONS" | jq 'length')

if [ "$ACTION_COUNT" -eq 0 ]; then
  echo "  No CUSTOM_ACTION webhooks found."
  exit 0
fi

for i in $(seq 0 $((ACTION_COUNT - 1))); do
  action=$(echo "$ACTIONS" | jq -c ".[$i]")
  ACTION_ID=$(echo "$action" | jq -r '.id')
  ACTION_NAME=$(echo "$action" | jq -r '.name')

  ADAPTER_URL="${ADAPTER_URL_BASE}/webhook/${ACTION_NAME// /-}"

  echo "  Updating '$ACTION_NAME' → $ADAPTER_URL"
  UPDATE_RESP=$(curl -s -b "$COOKIE_JAR" \
    -X POST "${COOP_API_URL}/api/v1/graphql" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg id "$ACTION_ID" \
      --arg url "$ADAPTER_URL" \
      --argjson headers "$AUTH_HEADERS" \
      '{
        "query": "mutation UpdateAction($input: UpdateActionInput!) { updateAction(input: $input) { ... on MutateActionSuccessResponse { data { id name callbackUrl } } ... on ActionNameExistsError { title } } }",
        "variables": {
          "input": {
            "id": $id,
            "callbackUrl": $url,
            "callbackUrlHeaders": $headers
          }
        }
      }')")

  UPDATED_URL=$(echo "$UPDATE_RESP" | jq -r '.data.updateAction.data.callbackUrl // empty' 2>/dev/null || true)
  if [ "$UPDATED_URL" = "$ADAPTER_URL" ]; then
    echo "$UPDATE_RESP" | jq '.data.updateAction.data'
  else
    echo "ERROR: failed to update '$ACTION_NAME'"
    echo "$UPDATE_RESP" | jq . 2>/dev/null || echo "$UPDATE_RESP"
    exit 1
  fi
done

echo ""
echo "==> Done. Actions now point at ${ADAPTER_URL_BASE}."
echo "    Run the adapter from support-trust-safety: source .env.demo && node scripts/coop-webhook-adapter.mjs"
