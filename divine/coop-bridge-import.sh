#!/usr/bin/env bash
# Pull Kind 1984 reports from staging relay-manager and submit to local COOP
# Usage: source .env.demo && ./divine/coop-bridge-import.sh
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

# Normalize a raw report reason to the canonical token COOP routing rules match.
# Mirrors the bridge's _REASON_ALIASES / CANONICAL_REASONS (osprey
# divine/nostr-kafka-bridge/main.py), the single source of truth -- keep in sync.
# Without this, imported reports carry raw tokens (e.g. 'NS-nudity', 'childSafety',
# 'child-safety') and fall to General Review instead of their category queue.
normalize_reason() {
  local r
  r=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$r" in
    sexual_minors|ns-csam) echo "csam" ;;
    child-safety|childsafety|ns-childsafety) echo "child_safety" ;;
    underage-user|underageuser|ns-underageuser) echo "underage_user" ;;
    sexual-content|sexualcontent|sexual|explicit|pornography|ns-nudity|ns-sexual-content|ns) echo "nudity" ;;
    profanity|ns-harassment) echo "harassment" ;;
    ns-spam) echo "spam" ;;
    ns-violence|vi) echo "violence" ;;
    ai-generated|aigenerated|ai) echo "ai_generated" ;;
    false-information|false-info|falseinformation|ns-other) echo "other" ;;
    *) echo "$r" ;;
  esac
}

# Fetch a Nostr event by ID from the relay via WebSocket.
# Extracts media URL and thumbnail from imeta tags.
fetch_event_media() {
  local event_id="$1"
  # event_id comes from a kind-1984 report's e-tag and is attacker-controlled.
  # Reject anything that is not a 64-char lowercase-hex Nostr id, so report data
  # can never reach a shell or be re-parsed as a command.
  if [[ ! "$event_id" =~ ^[0-9a-f]{64}$ ]]; then
    echo ""
    return
  fi

  # Use websocat if available, fall back to empty
  if ! command -v websocat >/dev/null 2>&1; then
    echo ""
    return
  fi

  # Pipe directly into websocat — no nested `bash -c`, so $req is never parsed as shell.
  local req='["REQ","media",{"ids":["'"$event_id"'"],"limit":1}]'
  echo "$req" | timeout 5 websocat -n1 "$RELAY_URL" 2>/dev/null > "$RELAY_EVENT_FILE" || true

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
REJECTED=0

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
  # Extract the raw report reason with the same priority as the live bridge
  # (osprey/divine/nostr-kafka-bridge/main.py _wrap_nostr_event): 1) explicit 'report'
  # tag, 2) NIP-32 'l' tag in the social.nos.ontology namespace (strip the NS- prefix),
  # 3) 'l' tag in the MOD namespace, 4) the 3rd element of the e/p tag (mobile/web
  # primary format), 5) the moderation-service content JSON "type". Reading only the
  # first 'l' tag (the old behaviour) silently sent any report whose reason lived in a
  # 'report' tag or the e/p 3rd element to General Review. The freetext keyword-scan
  # last resort in main.py is deliberately NOT ported: it is the most error-prone path
  # and a backfill can safely leave those rare reports to General Review.
  RAW_REASON=$(echo "$EVENT" | jq -r '
    def firstne(xs): (xs | map(select(. != null and . != "")) | .[0]) // "";
    (.tags // []) as $t |
    firstne([
      ( $t[] | select(.[0]=="report") | .[1] ),
      ( $t[] | select(.[0]=="l" and (.[2]=="social.nos.ontology")) | (.[1] | sub("^NS-";"")) ),
      ( $t[] | select(.[0]=="l" and (.[2]=="MOD")) | .[1] ),
      ( $t[] | select((.[0]=="e") or (.[0]=="p")) | .[2] ),
      ( (.content | fromjson?) | (if type=="object" then .type else empty end) )
    ])
  ')
  NORM_REASON=$(normalize_reason "${RAW_REASON:-other}")

  # Fetch media URL from the reported event (if it has imeta tags)
  MEDIA_INFO=$(fetch_event_media "${REPORTED_EVENT:-}")
  MEDIA_URL="${MEDIA_INFO%%|*}"
  MEDIA_THUMB="${MEDIA_INFO##*|}"

  # userId is the job SUBJECT: the reported (offending) user, NOT the reporter. This
  # mirrors the Osprey COOPSink (coop_sink.py sets userId = ReportedPubkey, falling
  # back to the event author only when there is no reported pubkey). Keying it on the
  # reporter would aim user-level enforcement and the MRT subject at the wrong account.
  # content.pubkey deliberately stays the report AUTHOR to match coop_sink.py
  # (content.pubkey = processed-event Pubkey = reporter); the offender travels in
  # reported_pubkey, which is the field the webhook adapter actually enforces on.
  COOP_BODY=$(jq -n \
    --arg contentId "$EVENT_ID" \
    --arg reportEventId "$EVENT_ID" \
    --arg reporterPubkey "$PUBKEY" \
    --arg reportedPubkey "${REPORTED_PUBKEY:-unknown}" \
    --arg reportedEvent "${REPORTED_EVENT:-unknown}" \
    --arg reasonCategory "$NORM_REASON" \
    --arg reasonText "$CONTENT" \
    --arg mediaUrl "$MEDIA_URL" \
    --arg mediaThumb "$MEDIA_THUMB" \
    '{
      contentId: $contentId,
      contentType: "nostr_event",
      userId: (if $reportedPubkey != "" and $reportedPubkey != "unknown" then $reportedPubkey else $reporterPubkey end),
      content: ({
        event_id: $reportEventId,
        pubkey: $reporterPubkey,
        reported_pubkey: $reportedPubkey,
        reported_event_id: $reportedEvent,
        report_reason: $reasonCategory,
        text: $reasonText
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
    echo "  [$((i+1))/$TOTAL] Submitted report $EVENT_ID (${REPORT_TYPE:-unknown} -> $NORM_REASON) → COOP"
  else
    # COOP returns 400 for schema/validation rejections (unknown content type,
    # field mismatch, invalid data) — these are real failures, NOT benign skips.
    # Surface the response body so the operator sees the actual reason.
    REJECTED=$((REJECTED + 1))
    echo "  [$((i+1))/$TOTAL] REJECTED $EVENT_ID: HTTP $RESP_CODE"
    echo "    $(echo "$RESP_BODY" | tr '\n' ' ' | head -c 300)"
  fi
done

echo ""
if [ "$REJECTED" -gt 0 ]; then
  echo "==> FAILED: $SUBMITTED submitted, $REJECTED REJECTED (of $TOTAL). See rejections above."
  exit 1
fi
echo "==> Done: $SUBMITTED submitted, 0 rejected (of $TOTAL total)"
