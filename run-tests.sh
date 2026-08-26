#!/usr/bin/env bash
#
# API Rate Limiting PoC - Test Runner
# Usage: ./run-tests.sh
#
# IMPORTANT NOTES ABOUT DISTRIBUTED RATE LIMITING:
# - The rate limit window is 60 seconds and PERSISTS across scenarios.
#   Scenarios run back-to-back share the same counter state for each org.
# - The Workers Rate Limiting binding is eventually consistent; slight
#   overshoot (1-2 requests beyond the limit) is expected behavior.
# - Each run generates unique timestamped org IDs so counters are always
#   fresh. Override with ORG_A, ORG_B, ORG_C env vars to pin specific orgs.
#

set -euo pipefail

DEBUG=0
for arg in "$@"; do
  if [[ "$arg" == "--debug" ]]; then
    DEBUG=1
  fi
done

DOMAIN="${DOMAIN:-api.humorous-jargon.sxpdemo.com}"
BASE_URL="https://${DOMAIN}"

# Extract limit from wrangler.toml if available, otherwise default to 10
WRANGLER_TOML="${WRANGLER_TOML:-workers/rate-limiter/wrangler.toml}"
LIMIT=10
if [[ -f "$WRANGLER_TOML" ]]; then
  parsed_limit=$(grep -E '^\s*limit\s*=' "$WRANGLER_TOML" | head -n1 | sed -E 's/.*=\s*([0-9]+).*/\1/' || true)
  [[ -n "$parsed_limit" ]] && LIMIT="$parsed_limit"
fi

# Use a unique run ID so every test run starts with fresh counters.
# The Workers Rate Limiting binding has no reset API; counters persist
# for the full 60-second window. Timestamped org IDs guarantee clean
# state on every invocation without waiting.
RUN_ID=$(date +%s)
ORG_A="${ORG_A:-org-alpha-${RUN_ID}}"
ORG_B="${ORG_B:-org-beta-${RUN_ID}}"
ORG_C="${ORG_C:-org-gamma-${RUN_ID}}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color


debug_curl() {
  if [[ "$DEBUG" -eq 1 ]]; then
    echo -e "${YELLOW}[debug] curl $*${NC}" >&2
  fi
  curl "$@"
}

count_status() {
  local status="$1"
  shift
  local count=0
  for s in "$@"; do
    if [[ "$s" == "$status" ]]; then
      ((count++)) || true
    fi
  done
  echo "$count"
}

print_header() {
  echo ""
  echo -e "${BLUE}============================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}============================================${NC}"
}

# --- Scenario A: API Key auth, per-organization throttling ---
run_scenario_a() {
  print_header "Scenario A: API Key auth (${ORG_A})"
  echo "Sending $((LIMIT + 2)) requests to ${BASE_URL}/api/${ORG_A}/devices"
  echo "Expected: first ${LIMIT} return 200, then 429"
  echo ""

  local statuses=()
  for i in $(seq 1 $((LIMIT + 2))); do
    local status
    status=$(debug_curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/${ORG_A}/devices")
    statuses+=("$status")
    if [[ "$status" == "200" ]]; then
      echo -e "  Request $i: ${GREEN}${status}${NC}"
    else
      echo -e "  Request $i: ${RED}${status}${NC}"
    fi
  done

  local ok_count
  ok_count=$(count_status "200" "${statuses[@]}")
  local rate_limited_count
  rate_limited_count=$(count_status "429" "${statuses[@]}")

  echo ""
  echo -e "  Results: ${GREEN}${ok_count} OK${NC}, ${RED}${rate_limited_count} Rate Limited${NC}"

  if [[ "$ok_count" -ge "$LIMIT" && "$rate_limited_count" -ge 1 ]]; then
    echo -e "  ${GREEN}PASS${NC}: Per-organization rate limiting works for API Key auth"
    return 0
  else
    echo -e "  ${YELLOW}WARN${NC}: Unexpected status distribution (got ${ok_count} OK, ${rate_limited_count} 429)"
    return 1
  fi
}

# --- Scenario B: JWT auth, per-organization throttling ---
# JWT generation uses jwt-demo/generate-jwt.js and produces a signed ES256
# token validated by API Shield. Requires node and jwt-demo/private-key.pem.
run_scenario_b() {
  print_header "Scenario B: JWT auth (${ORG_B})"

  local jwt
  jwt=$(node jwt-demo/generate-jwt.js "${ORG_B}" 2>/dev/null | grep '^ey' | head -1) || true
  echo "Generated signed ES256 JWT for organizationId=${ORG_B}"
  if [[ -z "$jwt" ]]; then
    echo -e "  ${RED}ERROR${NC}: JWT generation failed. Run 'npm run jwt:keys' to generate jwt-demo/private-key.pem."
    return 1
  fi
  echo "Sending $((LIMIT + 2)) requests with JWT to ${BASE_URL}/api/${ORG_B}/devices"
  echo "Expected: first ${LIMIT} return 200, then 429"
  echo ""

  local statuses=()
  for i in $(seq 1 $((LIMIT + 2))); do
    local status
    status=$(debug_curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${jwt}" "${BASE_URL}/api/${ORG_B}/devices")
    statuses+=("$status")
    if [[ "$status" == "200" ]]; then
      echo -e "  Request $i: ${GREEN}${status}${NC}"
    else
      echo -e "  Request $i: ${RED}${status}${NC}"
    fi
  done

  local ok_count
  ok_count=$(count_status "200" "${statuses[@]}")
  local rate_limited_count
  rate_limited_count=$(count_status "429" "${statuses[@]}")

  echo ""
  echo -e "  Results: ${GREEN}${ok_count} OK${NC}, ${RED}${rate_limited_count} Rate Limited${NC}"

  if [[ "$ok_count" -ge "$LIMIT" && "$rate_limited_count" -ge 1 ]]; then
    echo -e "  ${GREEN}PASS${NC}: Per-organization rate limiting works for JWT auth"
    return 0
  else
    echo -e "  ${YELLOW}WARN${NC}: Unexpected status distribution (got ${ok_count} OK, ${rate_limited_count} 429)"
    return 1
  fi
}

# --- Scenario C: Cross-organization isolation ---
run_scenario_c() {
  print_header "Scenario C: Cross-organization isolation"
  echo "Step 1: Exhaust ${ORG_A}'s quota (${LIMIT} requests)"

  for i in $(seq 1 "$LIMIT"); do
    debug_curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/${ORG_A}/devices" > /dev/null
  done
  echo "  ${ORG_A} quota exhausted"

  local failed=0

  echo ""
  echo "Step 2: Request as ${ORG_C} (should be 200, unaffected by ${ORG_A})"
  local status_gamma
  status_gamma=$(debug_curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/${ORG_C}/devices")

  if [[ "$status_gamma" == "200" ]]; then
    echo -e "  ${ORG_C} status: ${GREEN}${status_gamma}${NC}"
    echo -e "  ${GREEN}PASS${NC}: Organizations are isolated"
  else
    echo -e "  ${ORG_C} status: ${RED}${status_gamma}${NC}"
    echo -e "  ${RED}FAIL${NC}: ${ORG_C} was affected by ${ORG_A}'s rate limit"
    failed=1
  fi

  echo ""
  echo "Step 3: Verify ${ORG_A} is still rate limited"
  local status_alpha
  status_alpha=$(debug_curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/${ORG_A}/devices")
  if [[ "$status_alpha" == "429" ]]; then
    echo -e "  ${ORG_A} status: ${RED}${status_alpha}${NC}"
    echo -e "  ${GREEN}PASS${NC}: ${ORG_A} remains rate limited"
  else
    echo -e "  ${ORG_A} status: ${YELLOW}${status_alpha}${NC}"
    echo -e "  ${YELLOW}WARN${NC}: ${ORG_A} should still be rate limited"
    failed=1
  fi

  return $failed
}

# --- Main ---
FAILED=0

echo "API Rate Limiting PoC - Test Runner"
echo "Target: ${BASE_URL}"
echo "Rate limit: ${LIMIT} requests per 60 seconds"
echo "Org IDs : ${ORG_A} / ${ORG_B} / ${ORG_C}"
if [[ "$DEBUG" -eq 1 ]]; then
  echo -e "${YELLOW}[debug mode enabled]${NC}"
fi

run_scenario_a || FAILED=1
run_scenario_b || FAILED=1
run_scenario_c || FAILED=1

print_header "All scenarios complete"

exit $FAILED
