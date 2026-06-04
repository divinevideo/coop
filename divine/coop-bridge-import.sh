#!/usr/bin/env bash
# Pull Kind 1984 reports from staging relay-manager and submit to local COOP
# Usage: source .env.demo && ./scripts/coop-bridge-import.sh
set -euo pipefail

: "${CF_ACCESS_CLIENT_ID:?Set CF_ACCESS_CLIENT_ID in .env.demo}"
: "${CF_ACCESS_CLIENT_SECRET:?Set CF_ACCESS_CLIENT_SECRET in .env.demo}"
: "${RELAY_MANAGER_STAGING_URL:?Set RELAY_MANAGER_STAGING_URL in .env.demo}"
: "${COOP_API_URL:?Set COOP_API_URL in .env.demo}"
: "${COOP_API_KEY:?Set COOP_API_KEY in .env.demo}"

RELAY_URL="${RELAY_WS_URL:-wss://relay.staging.divine.video}"

REPORTS_FILE=$(mktemp)
RELAY_EVENT_FILE=$(mktemp)
trap 'rm -f "$REPORTS_FILE" "$RELAY_EVENT_FILE"' EXIT

# Fetch a Nostr event by ID from the relay via WebSocket.
# Extracts media URL and thumbnail from imeta tags.
fetch_event_media() {
  local event_id="$1"
  if [ -z "$event_id" ] || [ "$event_id" = "unknown" ]; then
    echo ""
    return
  fi

  # Use websocat if available, fall back to empty
  if ! command -v websocat >/dev/null 2>&1; then
    echo ""
    return
  fi

  local req='["REQ","media",{"ids":["'"$event_id"'"],"limit":1}]'
  timeout 5 bash -c "echo '$req' | websocat -n1 '$RELAY_URL' 2>/dev/null" > "$RELAY_EVENT_FILE" || true

  # Extract media URL from imeta tag: look for "url <value>" field
  local media_url=""
  local thumb_url=""
  if [ -s "$RELAY_EVENT_FILE" ]; then
    media_url=$(python3 -c "
import json, sys
for line in open('$RELAY_EVENT_FILE'):
    try:
        msg = json.loads(line.strip())
        if msg[0] == 'EVENT':
            for tag in msg[2].get('tags', []):
                if tag[0] == 'imeta':
                    u, t = '', ''
                    for field in tag[1:]:
                        if field.startswith('url '):
                            u = field[4:]
                        elif field.startswith('thumb '):
                            t = field[6:]
                    if u:
                        print(u)
                        if t:
                            print(t, file=sys.stderr)
                        sys.exit(0)
    except: pass
" 2>"$RELAY_EVENT_FILE.thumb")
    thumb_url=$(cat "$RELAY_EVENT_FILE.thumb" 2>/dev/null)
    rm -f "$RELAY_EVENT_FILE.thumb"
  fi

  echo "${media_url}|${thumb_url}"
}

echo "==> Fetching Kind 1984 reports from staging relay-manager..."
HTTP_CODE=$(curl -s -o "$REPORTS_FILE" -w '%{http_code}' \
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
  "${RELAY_MANAGER_STAGING_URL}/api/reports")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: staging relay-manager returned HTTP $HTTP_CODE"
  cat "$REPORTS_FILE"
  exit 1
fi

TOTAL=$(jq '.events | length' "$REPORTS_FILE")
echo "==> Got $TOTAL reports from staging relay"

if [ "$TOTAL" -eq 0 ]; then
  echo "No reports to import."
  exit 0
fi

SUBMITTED=0
SKIPPED=0
ERRORS=0

for i in $(seq 0 $((TOTAL - 1))); do
  EVENT=$(jq -c ".events[$i]" "$REPORTS_FILE")
  EVENT_ID=$(echo "$EVENT" | jq -r '.id')
  PUBKEY=$(echo "$EVENT" | jq -r '.pubkey')
  CREATED_AT=$(echo "$EVENT" | jq -r '.created_at')
  CONTENT=$(echo "$EVENT" | jq -r '.content')
  KIND=$(echo "$EVENT" | jq -r '.kind')

  # Extract reported pubkey and event from tags
  REPORTED_PUBKEY=$(echo "$EVENT" | jq -r '[.tags[] | select(.[0]=="p")] | .[0][1] // ""')
  REPORTED_EVENT=$(echo "$EVENT" | jq -r '[.tags[] | select(.[0]=="e")] | .[0][1] // ""')
  REPORT_TYPE=$(echo "$EVENT" | jq -r '[.tags[] | select(.[0]=="l")] | .[0][1] // ""')

  # Fetch media URL from the reported event (if it has imeta tags)
  MEDIA_INFO=$(fetch_event_media "${REPORTED_EVENT:-}")
  MEDIA_URL="${MEDIA_INFO%%|*}"
  MEDIA_THUMB="${MEDIA_INFO##*|}"

  COOP_BODY=$(jq -n \
    --arg contentId "$EVENT_ID" \
    --arg userId "$PUBKEY" \
    --arg reportEventId "$EVENT_ID" \
    --arg reporterPubkey "$PUBKEY" \
    --arg reportedPubkey "${REPORTED_PUBKEY:-unknown}" \
    --arg reportedEvent "${REPORTED_EVENT:-unknown}" \
    --arg reasonCategory "${REPORT_TYPE:-other}" \
    --arg reasonText "$CONTENT" \
    --arg mediaUrl "$MEDIA_URL" \
    --arg mediaThumb "$MEDIA_THUMB" \
    '{
      contentId: $contentId,
      contentType: "User Report",
      userId: $reporterPubkey,
      content: ({
        report_event_id: $reportEventId,
        reporter_pubkey: $reporterPubkey,
        reported_pubkey: $reportedPubkey,
        reported_event_id: $reportedEvent,
        reason_category: $reasonCategory,
        reason_text: $reasonText
      } + (if $mediaUrl != "" then { media_url: $mediaUrl } else {} end)
        + (if $mediaThumb != "" then { media_thumbnail: $mediaThumb } else {} end)),
      sync: true
    }')

  RESP_FILE=$(mktemp)
  RESP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "${COOP_API_URL}/api/v1/content" \
    -H "x-api-key: ${COOP_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$COOP_BODY")
  RESP_BODY=$(cat "$RESP_FILE")
  rm -f "$RESP_FILE"

  if [ "$RESP_CODE" = "200" ] || [ "$RESP_CODE" = "202" ]; then
    SUBMITTED=$((SUBMITTED + 1))
    echo "  [$((i+1))/$TOTAL] Submitted report $EVENT_ID (${REPORT_TYPE:-unknown}) → COOP"
  elif [ "$RESP_CODE" = "400" ]; then
    SKIPPED=$((SKIPPED + 1))
    echo "  [$((i+1))/$TOTAL] Skipped $EVENT_ID (400: likely duplicate or schema mismatch)"
  else
    ERRORS=$((ERRORS + 1))
    echo "  [$((i+1))/$TOTAL] ERROR $EVENT_ID: HTTP $RESP_CODE"
    echo "    $RESP_BODY" | head -3
  fi
done

echo ""
echo "==> Done: $SUBMITTED submitted, $SKIPPED skipped, $ERRORS errors (of $TOTAL total)"
