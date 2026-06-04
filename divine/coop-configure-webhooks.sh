#!/usr/bin/env bash
# Configure COOP CUSTOM_ACTION webhooks to point at staging relay-manager
# Usage: source .env.demo && ./scripts/coop-configure-webhooks.sh
set -euo pipefail

: "${ADMIN_API_KEY:?Set ADMIN_API_KEY in .env.demo}"
: "${CF_ACCESS_CLIENT_ID:?Set CF_ACCESS_CLIENT_ID in .env.demo}"
: "${CF_ACCESS_CLIENT_SECRET:?Set CF_ACCESS_CLIENT_SECRET in .env.demo}"
: "${RELAY_MANAGER_STAGING_URL:?Set RELAY_MANAGER_STAGING_URL in .env.demo}"
: "${COOP_API_URL:?Set COOP_API_URL in .env.demo}"

# We need a session cookie from COOP for GraphQL
COOP_EMAIL="${COOP_EMAIL:-matt@divine.video}"
COOP_PASSWORD="${COOP_PASSWORD:-test1234}"
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
# Instead, we'll point COOP at a thin adapter endpoint.
# For the demo, we'll write a local adapter that receives COOP's webhook
# and translates to relay-manager RPC format.

# Filter to only CustomActions (those with callbackUrl)
ACTIONS=$(echo "$ACTIONS_RESP" | jq -c '[.data.myOrg.actions[] | select(.callbackUrl)]' 2>/dev/null)
ACTION_COUNT=$(echo "$ACTIONS" | jq 'length')

for i in $(seq 0 $((ACTION_COUNT - 1))); do
  action=$(echo "$ACTIONS" | jq -c ".[$i]")
  ACTION_ID=$(echo "$action" | jq -r '.id')
  ACTION_NAME=$(echo "$action" | jq -r '.name')

  # For now, point all webhooks at the local adapter (port 3456)
  ADAPTER_URL="http://localhost:3456/webhook/${ACTION_NAME// /-}"

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

  echo "$UPDATE_RESP" | jq '.data.updateAction.data // .errors[0].message // "unknown error"' 2>/dev/null || echo "  WARNING: $UPDATE_RESP"
done

echo ""
echo "==> Done. Actions now point at local adapter on port 3456."
echo "    Run the adapter: source .env.demo && node scripts/coop-webhook-adapter.mjs"
