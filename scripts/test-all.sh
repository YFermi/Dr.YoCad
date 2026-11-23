#!/usr/bin/env bash
# Runs every Cadline test suite against the Fastify API and exits non-zero if
# any fail. Expects the stack to be up (docker compose, migrate, seed, API).
#
#   bash scripts/test-all.sh
#
# Env: API_URL (default http://localhost:4000/api/v1),
#      CADLINE_READY_TIMEOUT_S (default 180) for health + seeded conversions.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"
export API_URL="${API_URL:-http://localhost:4000/api/v1}"
READY_TIMEOUT_S="${CADLINE_READY_TIMEOUT_S:-180}"

# shellcheck source=lib/auth.sh
source "${ROOT_DIR}/scripts/lib/auth.sh"
# shellcheck source=lib/upload.sh
source "${ROOT_DIR}/scripts/lib/upload.sh"

echo "== Cadline test-all against ${API_URL}"

# --- 1. API health (Postgres, Redis, S3 all reachable) ---------------------
deadline=$(( $(date +%s) + READY_TIMEOUT_S ))
until curl -fsS "${API_URL}/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "FATAL: ${API_URL}/health not healthy after ${READY_TIMEOUT_S}s:"
    curl -sS "${API_URL}/health" || true
    exit 1
  fi
  sleep 2
done
echo "-- API healthy"

# --- 2. Seeded files finished converting --------------------------------------
cadline_login admin@demo.local 'Password123!' || exit 1
PROJECT_ID=$(curl -sS "${API_URL}/projects?page=1&pageSize=50" -H "Authorization: Bearer ${CADLINE_TOKEN}" |
  cadline_json_field 'data.data.items.find(p => p.id === "prj_demo_gearbox")?.id') || {
  echo "FATAL: seeded project prj_demo_gearbox not found (did you run 'pnpm --filter api seed'?)"
  exit 1
}
while :; do
  pending=$(curl -sS "${API_URL}/files?projectId=${PROJECT_ID}" -H "Authorization: Bearer ${CADLINE_TOKEN}" |
    cadline_json_field 'data.data.items.filter(f => f.id.startsWith("fil_demo_")).map(f => f.name + "=" + f.status).filter(s => !s.endsWith("=READY")).join(" ") || "none"')
  [ "${pending}" = "none" ] && break
  if echo "${pending}" | grep -q "=FAILED"; then
    echo "FATAL: seeded file conversion failed: ${pending}"
    exit 1
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "FATAL: seeded files not READY after ${READY_TIMEOUT_S}s: ${pending}"
    exit 1
  fi
  sleep 2
done
echo "-- Seeded files READY"

# --- 3. Browser upload path (presigned S3 multipart via scripts/lib/upload.sh)
if UPLOAD_RESULT=$(cadline_upload "${PROJECT_ID}" scripts/seed-models/cube-50mm.stl "preflight-cube-50mm.stl" model/stl); then
  echo "-- Presigned multipart upload -> READY (${UPLOAD_RESULT%%|*})"
else
  echo "FATAL: presigned multipart upload preflight failed"
  exit 1
fi

# --- 4. Suites ------------------------------------------------------------------
declare -a NAMES=() CODES=()
run_suite() {
  local name="$1"; shift
  echo
  echo "================ ${name} ================"
  local log
  log="$(mktemp)"
  "$@" 2>&1 | tee "${log}"
  local code=${PIPESTATUS[0]}
  NAMES+=("${name}")
  CODES+=("${code}")
  # In GitHub Actions, surface each failing suite's tail as an annotation.
  if [ "${code}" -ne 0 ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error title=${name} failed (exit ${code})::$(tail -n 40 "${log}" | tail -c 5000 |
      sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk 'BEGIN { ORS = "%0A" } { print }')"
  fi
  rm -f "${log}"
}

run_suite "geometry unit tests" node_modules/.bin/tsx --test apps/web/src/lib/geometry/cylinders.test.ts apps/web/src/lib/geometry/edgeLoops.test.ts apps/web/src/lib/geometry/measurements.test.ts apps/web/src/lib/geometry/planarRegions.test.ts
run_suite "test-annotations" bash scripts/test-annotations.sh
run_suite "test-2d" bash scripts/test-2d.sh
run_suite "test-realtime" bash scripts/test-realtime.sh
run_suite "test-realtime-reconnect" bash scripts/test-realtime-reconnect.sh
run_suite "test-ai" bash scripts/test-ai.sh
run_suite "test-measurements" bash scripts/test-measurements.sh

echo
echo "================ Summary ================"
failed=0
for i in "${!NAMES[@]}"; do
  if [ "${CODES[$i]}" -eq 0 ]; then
    printf 'PASS  %-26s exit=0\n' "${NAMES[$i]}"
  else
    printf 'FAIL  %-26s exit=%s\n' "${NAMES[$i]}" "${CODES[$i]}"
    failed=$((failed + 1))
  fi
done
echo "${failed} of ${#NAMES[@]} suites failed"
[ "${failed}" -eq 0 ]
