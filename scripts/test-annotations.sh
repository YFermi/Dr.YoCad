#!/usr/bin/env bash
set -euo pipefail

# End-to-end Session 3 API smoke test:
# register -> login (demo admin for seeded project/file) -> get seeded file
# -> POST annotation -> POST comment -> GET comments
#
# Usage:
#   API_URL=http://localhost:3000/api/v1 bash scripts/test-annotations.sh
#   API_URL=http://localhost:4000/api/v1 bash scripts/test-annotations.sh

API_URL="${API_URL:-http://localhost:3000/api/v1}"
PASS_COUNT=0
FAIL_COUNT=0

json_get() {
  local expr="$1"
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    const val = (${expr});
    if (val === undefined || val === null) process.exit(1);
    process.stdout.write(typeof val === 'object' ? JSON.stringify(val) : String(val));
  "
}

step_pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

step_fail() {
  echo "FAIL: $1 — $2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

echo "Testing Cadline Session 3 endpoints against ${API_URL}"
echo "------------------------------------------------------------"

# 1. Register a fresh user
UNIQUE_EMAIL="reviewer-$(date +%s)-$RANDOM@demo.local"
REG_RESP=$(curl -sS -X POST "${API_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${UNIQUE_EMAIL}\",\"password\":\"Password123!\",\"name\":\"QA Reviewer\",\"organizationName\":\"QA Org\"}")

if echo "${REG_RESP}" | json_get 'data.success && data.data.tokens.accessToken' >/dev/null 2>&1; then
  step_pass "1. POST /auth/register (${UNIQUE_EMAIL})"
else
  step_fail "1. POST /auth/register" "${REG_RESP}"
fi

# 2. Login as seeded admin to access seeded project & CAD files
LOGIN_RESP=$(curl -sS -X POST "${API_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.local","password":"Password123!"}')

TOKEN=$(echo "${LOGIN_RESP}" | json_get 'data.data.tokens.accessToken' 2>/dev/null || true)
if [ -n "${TOKEN}" ]; then
  step_pass "2. POST /auth/login (admin@demo.local)"
else
  step_fail "2. POST /auth/login" "${LOGIN_RESP}"
  exit 1
fi

# 3. Get seeded project & first seeded file + versionId
PROJECTS_RESP=$(curl -sS "${API_URL}/projects?page=1&pageSize=10" \
  -H "Authorization: Bearer ${TOKEN}")
PROJECT_ID=$(echo "${PROJECTS_RESP}" | json_get 'data.data.items[0].id' 2>/dev/null || true)

FILES_RESP=$(curl -sS "${API_URL}/files?projectId=${PROJECT_ID}" \
  -H "Authorization: Bearer ${TOKEN}")
FILE_ID=$(echo "${FILES_RESP}" | json_get '(Array.isArray(data.data) ? data.data : data.data.items)[0].id' 2>/dev/null || true)
VERSION_ID=$(echo "${FILES_RESP}" | json_get '(Array.isArray(data.data) ? data.data : data.data.items)[0].versions[0].id' 2>/dev/null || true)

if [ -n "${FILE_ID}" ] && [ -n "${VERSION_ID}" ]; then
  step_pass "3. GET seeded file (${FILE_ID}, version ${VERSION_ID})"
else
  step_fail "3. GET seeded file" "${FILES_RESP}"
  exit 1
fi

# 4. POST annotation
ANN_RESP=$(curl -sS -X POST "${API_URL}/files/${FILE_ID}/annotations" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"versionId\": \"${VERSION_ID}\",
    \"type\": \"PIN\",
    \"label\": \"Smoke test chamfer check\",
    \"payload\": {
      \"anchor\": {
        \"position\": [12.5, 25.0, -8.25],
        \"normal\": [0, 1, 0],
        \"cameraPose\": {
          \"position\": [90, 75, 90],
          \"target\": [0, 20, 0],
          \"zoom\": 1
        },
        \"partId\": \"part-1\"
      }
    }
  }")

ANN_ID=$(echo "${ANN_RESP}" | json_get 'data.data.id' 2>/dev/null || true)
if [ -n "${ANN_ID}" ]; then
  step_pass "4. POST /files/${FILE_ID}/annotations (${ANN_ID})"
else
  step_fail "4. POST /files/${FILE_ID}/annotations" "${ANN_RESP}"
  exit 1
fi

# 5. POST comment linked to annotation
CMT_RESP=$(curl -sS -X POST "${API_URL}/files/${FILE_ID}/comments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"body\": \"@user@demo.local Verify edge fillet tolerance on smoke test pin.\",
    \"annotationId\": \"${ANN_ID}\"
  }")

CMT_ID=$(echo "${CMT_RESP}" | json_get 'data.data.id' 2>/dev/null || true)
if [ -n "${CMT_ID}" ]; then
  step_pass "5. POST /files/${FILE_ID}/comments (${CMT_ID})"
else
  step_fail "5. POST /files/${FILE_ID}/comments" "${CMT_RESP}"
  exit 1
fi

# 6. GET comments filtered by annotationId
GET_CMTS_RESP=$(curl -sS "${API_URL}/files/${FILE_ID}/comments?annotationId=${ANN_ID}" \
  -H "Authorization: Bearer ${TOKEN}")

FOUND_ID=$(echo "${GET_CMTS_RESP}" | json_get "data.data.items.find(c => c.id === '${CMT_ID}')?.id" 2>/dev/null || true)
if [ "${FOUND_ID}" = "${CMT_ID}" ]; then
  step_pass "6. GET /files/${FILE_ID}/comments?annotationId=${ANN_ID}"
else
  step_fail "6. GET /files/${FILE_ID}/comments" "${GET_CMTS_RESP}"
fi

# 7. PATCH comment resolve + verify GET annotations resolvedCommentCount
PATCH_CMT_RESP=$(curl -sS -X PATCH "${API_URL}/comments/${CMT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"resolved":true}')

IS_RESOLVED=$(echo "${PATCH_CMT_RESP}" | json_get 'data.data.resolved' 2>/dev/null || true)
if [ "${IS_RESOLVED}" = "true" ]; then
  step_pass "7. PATCH /comments/${CMT_ID} (resolved=true)"
else
  step_fail "7. PATCH /comments/${CMT_ID}" "${PATCH_CMT_RESP}"
fi

# 8. POST, GET, and DELETE persisted measurement
MEAS_RESP=$(curl -sS -X POST "${API_URL}/files/${FILE_ID}/measurements" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"versionId\": \"${VERSION_ID}\",
    \"type\": \"DISTANCE\",
    \"label\": \"Smoke test span\",
    \"value\": 42.5,
    \"unit\": \"mm\",
    \"points\": {
      \"coordinates\": [
        {\"x\": 0, \"y\": 0, \"z\": 0},
        {\"x\": 42.5, \"y\": 0, \"z\": 0}
      ]
    }
  }")

MEAS_ID=$(echo "${MEAS_RESP}" | json_get 'data.data.id' 2>/dev/null || true)
GET_MEAS_RESP=$(curl -sS "${API_URL}/files/${FILE_ID}/measurements?versionId=${VERSION_ID}" \
  -H "Authorization: Bearer ${TOKEN}")
FOUND_MEAS=$(echo "${GET_MEAS_RESP}" | json_get "data.data.find(m => m.id === '${MEAS_ID}')?.id" 2>/dev/null || true)
if [ -n "${MEAS_ID}" ] && [ "${FOUND_MEAS}" = "${MEAS_ID}" ]; then
  step_pass "8. POST & GET /files/${FILE_ID}/measurements (${MEAS_ID})"
else
  step_fail "8. POST & GET /files/${FILE_ID}/measurements" "${MEAS_RESP} | ${GET_MEAS_RESP}"
fi

# Clean up smoke-test entities so demo data stays clean
DEL_MEAS=$(curl -sS -X DELETE "${API_URL}/measurements/${MEAS_ID}" -H "Authorization: Bearer ${TOKEN}")
DEL_ANN=$(curl -sS -X DELETE "${API_URL}/annotations/${ANN_ID}" -H "Authorization: Bearer ${TOKEN}")
if echo "${DEL_MEAS}" | json_get 'data.success' >/dev/null 2>&1 && echo "${DEL_ANN}" | json_get 'data.success' >/dev/null 2>&1; then
  step_pass "9. DELETE cleanup (/measurements/${MEAS_ID}, /annotations/${ANN_ID})"
else
  step_fail "9. DELETE cleanup" "${DEL_MEAS} | ${DEL_ANN}"
fi

echo "------------------------------------------------------------"
echo "Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
[ "${FAIL_COUNT}" -eq 0 ]
