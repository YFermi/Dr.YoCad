#!/usr/bin/env bash
# End-to-end smoke test for STANDALONE mode (no Docker, Postgres, Redis or S3):
#
#   bash scripts/test-standalone.sh
#
#  1. Uses a STANDALONE API already listening on :4000, or starts
#     `npm run dev:standalone` in the background.
#  2. Waits for GET /api/v1/health -> 200.
#  3. Creates two annotations with NO Authorization header.
#  4. Reads them back and checks the count went up by 2.
#  5. Uploads scripts/seed-models/cube-50mm.stl through the browser flow
#     (init -> PUT part to its presigned URL -> complete), no auth header, and
#     waits for conversion to READY.
#  6. Asserts the conversion wrote a GLB (glTF magic) under ./data/files/.
#  7. Stops the background app if this script started it. Exits 0 on success.
#
# Env: API_URL (default http://localhost:4000/api/v1), STANDALONE_DATA_DIR
#      (default ./data), CADLINE_STANDALONE_TIMEOUT_S (default 180).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"
API_URL="${API_URL:-http://localhost:4000/api/v1}"
DATA_DIR="${STANDALONE_DATA_DIR:-${ROOT_DIR}/data}"
TIMEOUT_S="${CADLINE_STANDALONE_TIMEOUT_S:-180}"
# shellcheck source=lib/auth.sh
source "${ROOT_DIR}/scripts/lib/auth.sh" # cadline_json_field only; no login

APP_PID=""
APP_LOG="$(mktemp)"
WORK="$(mktemp -d)"

stop_app() {
  [ -z "${APP_PID}" ] && return
  echo "-- stopping background dev:standalone (pid ${APP_PID})"
  if [ -r "/proc/${APP_PID}/winpid" ]; then
    # Git Bash / MSYS: node.exe children are native Windows processes that
    # POSIX signals do not reach; kill the whole Windows process tree.
    taskkill //PID "$(cat "/proc/${APP_PID}/winpid")" //T //F >/dev/null 2>&1 || true
  else
    kill -TERM -- "-${APP_PID}" 2>/dev/null || kill -TERM "${APP_PID}" 2>/dev/null || true
  fi
  wait "${APP_PID}" 2>/dev/null || true
  APP_PID=""
}
cleanup() {
  stop_app
  rm -rf "${WORK}" "${APP_LOG}"
}
trap cleanup EXIT

PASS=0
pass() { PASS=$((PASS + 1)); echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"
  [ -n "${2:-}" ] && echo "      ${2}" | head -c 2000 && echo
  if [ -n "${APP_PID}" ]; then
    echo "---- dev:standalone output (last 40 lines) ----"
    tail -n 40 "${APP_LOG}"
  fi
  exit 1
}

# --- 1. Reuse a running STANDALONE instance or start one ----------------------
if curl -fsS "${API_URL}/health" >/dev/null 2>&1; then
  # Only STANDALONE answers an authenticated route without a token.
  code=$(curl -sS -o /dev/null -w '%{http_code}' "${API_URL}/projects?page=1&pageSize=1")
  [ "${code}" = "200" ] ||
    fail "1. API on ${API_URL} is not in STANDALONE mode" "GET /projects without auth -> HTTP ${code} (expected 200); stop it or use the full-stack suites"
  pass "1. Using the STANDALONE API already running on ${API_URL}"
else
  set -m # own process group, so stop_app can signal the whole tree on POSIX
  npm run dev:standalone >"${APP_LOG}" 2>&1 &
  APP_PID=$!
  set +m
  pass "1. Started npm run dev:standalone in the background (pid ${APP_PID})"
fi

# --- 2. Health -----------------------------------------------------------------
deadline=$(( $(date +%s) + TIMEOUT_S ))
until curl -fsS "${API_URL}/health" >"${WORK}/health.json" 2>/dev/null; do
  if [ -n "${APP_PID}" ] && ! kill -0 "${APP_PID}" 2>/dev/null; then
    fail "2. GET /health" "dev:standalone exited before the API became healthy"
  fi
  [ "$(date +%s)" -ge "${deadline}" ] && fail "2. GET /health" "not 200 after ${TIMEOUT_S}s"
  sleep 1
done
pass "2. GET /health -> 200 $(cat "${WORK}/health.json")"

# Seeded STL fixture (first boot converts it in the background).
FILE_ID="fil_demo_carrier"
until curl -fsS "${API_URL}/files/${FILE_ID}" >"${WORK}/file.json" 2>/dev/null &&
  [ "$(cadline_json_field 'data.data.status' <"${WORK}/file.json")" = "READY" ]; do
  [ "$(date +%s)" -ge "${deadline}" ] && fail "2b. seeded ${FILE_ID} READY" "$(cat "${WORK}/file.json" 2>/dev/null)"
  sleep 1
done
VERSION_ID=$(cadline_json_field 'data.data.versions.find(v => v.versionNumber === data.data.currentVersion).id' <"${WORK}/file.json") ||
  fail "2b. seeded ${FILE_ID} version" "$(cat "${WORK}/file.json")"
PROJECT_ID=$(cadline_json_field 'data.data.projectId' <"${WORK}/file.json")

# --- 3. Two annotations, no Authorization header --------------------------------
count_annotations() {
  curl -sS "${API_URL}/files/${FILE_ID}/annotations?versionId=${VERSION_ID}" |
    cadline_json_field '(Array.isArray(data.data) ? data.data : data.data.items).length'
}
BEFORE=$(count_annotations) || fail "3. GET annotations (before)" "unexpected response"
for i in 1 2; do
  resp=$(curl -sS -X POST "${API_URL}/files/${FILE_ID}/annotations" \
    -H "Content-Type: application/json" \
    -d "{\"versionId\":\"${VERSION_ID}\",\"type\":\"PIN\",\"label\":\"standalone smoke ${i}\",
         \"payload\":{\"anchor\":{\"position\":[${i},2,3],\"normal\":[0,1,0],
         \"cameraPose\":{\"position\":[90,75,90],\"target\":[0,0,0],\"zoom\":1}}}}")
  id=$(printf '%s' "${resp}" | cadline_json_field 'data.data.id') ||
    fail "3. POST annotation ${i} without auth header" "${resp}"
  author=$(printf '%s' "${resp}" | cadline_json_field 'data.data.author?.name ?? data.data.userId' 2>/dev/null || echo '?')
  pass "3. POST /files/${FILE_ID}/annotations #${i} without auth header -> ${id} (author: ${author})"
done

# --- 4. Read back ----------------------------------------------------------------
AFTER=$(count_annotations) || fail "4. GET annotations (after)" "unexpected response"
[ "${AFTER}" -eq $((BEFORE + 2)) ] || fail "4. annotation count" "before=${BEFORE} after=${AFTER} (expected +2)"
pass "4. GET annotations: ${BEFORE} -> ${AFTER} (+2)"

# --- 5. Upload an STL through the browser flow and wait for READY ----------------
STL="scripts/seed-models/cube-50mm.stl"
NAME="standalone-smoke-$(date +%s).stl"
SIZE=$(wc -c <"${STL}" | tr -d ' ')
init=$(curl -sS -X POST "${API_URL}/files/init" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"${PROJECT_ID}\",\"fileName\":\"${NAME}\",\"mimeType\":\"model/stl\",\"sizeBytes\":${SIZE},\"chunkSize\":5242880}")
printf '%s' "${init}" >"${WORK}/init.json"
UP_FILE_ID=$(cadline_json_field 'data.data.file.id' <"${WORK}/init.json") &&
  UPLOAD_ID=$(cadline_json_field 'data.data.uploadId' <"${WORK}/init.json") &&
  PART_URL=$(cadline_json_field 'data.data.presignedUrls[0].url' <"${WORK}/init.json") ||
  fail "5. POST /files/init" "${init}"
code=$(curl -sS -X PUT "${PART_URL}" --data-binary "@${STL}" -D "${WORK}/h" -o "${WORK}/b" -w '%{http_code}')
ETAG=$(tr -d '\r' <"${WORK}/h" | awk -F': ' 'tolower($1) == "etag" { gsub(/"/, "", $2); print $2 }' | tail -1)
[ "${code}" = "200" ] && [ -n "${ETAG}" ] || fail "5. PUT part to presigned URL" "HTTP ${code} etag='${ETAG}' $(cat "${WORK}/b")"
done_resp=$(curl -sS -X POST "${API_URL}/files/${UP_FILE_ID}/complete" -H "Content-Type: application/json" \
  -d "{\"uploadId\":\"${UPLOAD_ID}\",\"parts\":[{\"partNumber\":1,\"etag\":\"${ETAG}\"}]}")
printf '%s' "${done_resp}" | cadline_json_field 'data.success === true || undefined' >/dev/null ||
  fail "5. POST /files/:id/complete" "${done_resp}"
state=""
until [ "${state}" = "READY" ]; do
  state=$(curl -sS "${API_URL}/files/${UP_FILE_ID}/status" | cadline_json_field 'data.data.status' 2>/dev/null || echo "?")
  [ "${state}" = "FAILED" ] && fail "5. conversion" "file ${UP_FILE_ID} FAILED"
  [ "$(date +%s)" -ge "${deadline}" ] && fail "5. conversion" "not READY after ${TIMEOUT_S}s (last: ${state})"
  [ "${state}" = "READY" ] || sleep 1
done
pass "5. Uploaded ${NAME} (${SIZE} B, file ${UP_FILE_ID}) -> conversion READY"

# --- 6. GLB on local disk ------------------------------------------------------
GLB=$(find "${DATA_DIR}/files" -path "*/${UP_FILE_ID}/*" -name '*.glb' -type f 2>/dev/null | head -1)
[ -n "${GLB}" ] || fail "6. GLB under ${DATA_DIR}/files" "no *.glb for ${UP_FILE_ID}"
MAGIC=$(head -c 4 "${GLB}")
[ "${MAGIC}" = "glTF" ] || fail "6. GLB magic" "${GLB} starts with '${MAGIC}'"
pass "6. GLB written to ${GLB#"${ROOT_DIR}"/} ($(wc -c <"${GLB}" | tr -d ' ') B, magic glTF)"

# --- 7. Stop the background app ------------------------------------------------
if [ -n "${APP_PID}" ]; then
  stop_app
  pass "7. Stopped background dev:standalone"
else
  pass "7. Left the pre-existing instance running"
fi
echo "${PASS} of 8 checks passed (STANDALONE: no Docker, Postgres, Redis, S3 or auth header)"
exit 0
