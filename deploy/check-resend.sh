#!/usr/bin/env bash
#
# Verify Resend credentials without printing the API key.
# Reads .env from the repo root.
#
#   bash deploy/check-resend.sh            # validate config only
#   bash deploy/check-resend.sh --send     # also send a real test email
#
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "No .env found in $(pwd)."; exit 1; }
set -a; source .env; set +a

fail=0
: "${RESEND_FROM:=Orion <onboarding@resend.dev>}"

if [[ -z "${RESEND_API_KEY:-}" ]]; then
  echo "  RESEND_API_KEY : MISSING"
  fail=1
elif [[ "$RESEND_API_KEY" != re_* ]]; then
  echo "  RESEND_API_KEY : suspicious (Resend keys start with 're_')"
  fail=1
else
  # /domains is a cheap authenticated GET, so the key is validated without
  # sending anything.
  resp=$(curl -s -m 15 -w '\n%{http_code}' https://api.resend.com/domains \
           -H "Authorization: Bearer ${RESEND_API_KEY}")
  code=$(tail -n1 <<<"$resp"); body=$(sed '$d' <<<"$resp")
  case "$code" in
    200) echo "  RESEND_API_KEY : OK"
         verified=$(grep -o '"name":"[^"]*"' <<<"$body" | sed 's/"name":"//;s/"//' | paste -sd, -)
         echo "  verified domains: ${verified:-<none — you must send from onboarding@resend.dev>}" ;;
    401|403) echo "  RESEND_API_KEY : REJECTED (401/403 — key invalid or revoked)"; fail=1 ;;
    *)   echo "  RESEND_API_KEY : unexpected HTTP $code"; fail=1 ;;
  esac
fi

if [[ -z "${RESEND_TO:-}" ]]; then
  echo "  RESEND_TO      : MISSING"
  fail=1
else
  echo "  RESEND_TO      : ${RESEND_TO}"
fi
echo "  RESEND_FROM    : ${RESEND_FROM}"

if [[ "$RESEND_FROM" == *onboarding@resend.dev* ]]; then
  echo
  echo "  Note: the shared onboarding@resend.dev sender may ONLY deliver to the"
  echo "  address registered on your Resend account. To send anywhere else,"
  echo "  verify your own domain and set RESEND_FROM to an address on it."
fi

if [[ $fail -eq 0 && "${1:-}" == "--send" ]]; then
  echo
  echo "  Sending test email..."
  resp=$(curl -s -m 20 -w '\n%{http_code}' -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer ${RESEND_API_KEY}" -H 'Content-Type: application/json' \
    -d "{\"from\":\"${RESEND_FROM}\",\"to\":[\"${RESEND_TO}\"],\"subject\":\"Orion test\",\"text\":\"Orion delivery is working.\"}")
  code=$(tail -n1 <<<"$resp"); body=$(sed '$d' <<<"$resp")
  if [[ "$code" == "200" ]]; then
    echo "  SENT — check ${RESEND_TO} (id $(grep -o '"id":"[^"]*"' <<<"$body" | head -1 | sed 's/"id":"//;s/"//'))"
  else
    echo "  FAILED HTTP $code: $body"; fail=1
  fi
fi

echo
[[ $fail -eq 0 ]] && echo "Resend ready. Next: npm run notify -- --dry-run" || echo "Fix the above, then re-run."
exit $fail
