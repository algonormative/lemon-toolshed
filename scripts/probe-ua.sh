#!/usr/bin/env bash
# Does the DEPLOYED surface answer a Python-stdlib agent?
#
# Measured 2026-09-03: the Pages ASSET layer 403s (`error code: 1010`) any
# request whose User-Agent is a Python stdlib default, while paths handled by
# CODE answer normally — the whole reason functions/[[path]].js exists. This is
# how the fix is proven against production, and how a regression is caught.
#
# Usage:  scripts/probe-ua.sh [host]   # default toolshed.lemon-agent.dev
#
# NOTHING HERE IS BILLED. Surface paths are free reads; the one POST carries no
# payment header, so the expected answer is the 402 quote — and a quote is not a
# purchase: no payment is constructed, signed or settled.
set -euo pipefail

HOST="${1:-${TOOLSHED_HOST:-toolshed.lemon-agent.dev}}"
BASE="https://${HOST}"

# Emitted by the build today: must be 200 for every agent.
SURFACES=(
  /llms.txt
  /llms-full.txt
  /openapi.json
  /catalog.json
  /robots.txt
)

# Routed by the /.well-known/* glob but not emitted yet (lands with vault-1x3u5).
# Probed anyway because WHICH failure matters: 404 is "no file", 403 is the bug.
PENDING=(
  /.well-known/x402
)

PAID=/convert/md-html

# The empty entry is the no-User-Agent case; `-H 'User-Agent:'` sends none at
# all, which is a different request from sending an empty string.
UAS=(
  'Python-urllib/3.14'
  'python-requests/2.32'
  'curl/8'
  'node'
  ''
)

fail=0

probe() { # probe <ua> <path> <expected...> -- <extra curl args...>
  local ua="$1" path="$2"; shift 2
  local expected=() code
  while [ "$#" -gt 0 ] && [ "$1" != '--' ]; do expected+=("$1"); shift; done
  [ "${1:-}" = '--' ] && shift
  if [ -z "$ua" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H 'User-Agent:' "$@" "${BASE}${path}" || echo 000)"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -A "$ua" "$@" "${BASE}${path}" || echo 000)"
  fi
  printf '%-22s | %-24s | %s\n' "${ua:-(none)}" "$path" "$code"
  for want in "${expected[@]}"; do [ "$code" = "$want" ] && return 0; done
  fail=1
}

printf '%-22s | %-24s | %s\n' 'UA' 'PATH' 'STATUS'
printf -- '-----------------------+--------------------------+-------\n'

for ua in "${UAS[@]}"; do
  for path in "${SURFACES[@]}"; do probe "$ua" "$path" 200; done
  for path in "${PENDING[@]}"; do probe "$ua" "$path" 200 404; done
  # Paid route, no payment header: 402 is the correct, unbilled answer.
  probe "$ua" "$PAID" 402 -- -X POST --data-binary '# hi'
done

echo
if [ "$fail" -ne 0 ]; then
  echo "FAIL: a surface did not answer 200 (404 tolerated for PENDING), or the paid"
  echo "      route did not answer 402. A 403 on a surface is the Pages static layer"
  echo "      (error 1010) — check dist/_routes.json shipped and lists that path."
  exit 1
fi
echo "OK: every surface reachable and the paid route 402, for every agent probed."
