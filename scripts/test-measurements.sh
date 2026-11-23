#!/usr/bin/env bash
set -euo pipefail

# End-to-end Session 7 Smart Measurement test suite:
# 1. Runs pure geometry unit tests (planarRegions, edgeLoops, cylinders, measurements)
# 2. Uploads cube-50mm.stl & plate-with-hole.stl via real upload+conversion API
# 3. Downloads converted GLB & verifies extracted L1/L2 geometry + analytic measurements
# 4. Verifies GET/POST /files/:id/features cache round-trip
# 5. Verifies SmartMeasurement POST/GET/PATCH/DELETE persistence round-trip
#
# Usage:
#   API_URL=http://localhost:3000/api/v1 bash scripts/test-measurements.sh

API_URL="${API_URL:-http://localhost:3000/api/v1}"
BASE_ORIGIN="${API_URL%/api/v1}"
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

upload_and_wait_ready() {
  local project_id="$1"
  local file_path="$2"
  local file_name="$3"
  local token="$4"
  local size_bytes
  size_bytes=$(wc -c < "${file_path}" | tr -d ' ')

  local init_resp
  init_resp=$(curl -sS -X POST "${API_URL}/files/init" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"projectId\":\"${project_id}\",\"fileName\":\"${file_name}\",\"mimeType\":\"model/stl\",\"sizeBytes\":${size_bytes}}")

  local file_id version_id upload_id
  file_id=$(echo "${init_resp}" | json_get 'data.data.file.id')
  version_id=$(echo "${init_resp}" | json_get 'data.data.version.id')
  upload_id=$(echo "${init_resp}" | json_get 'data.data.uploadId')

  local chunk_resp etag
  chunk_resp=$(curl -sS -X PUT "${API_URL}/files/${file_id}/chunk?uploadId=${upload_id}&partNumber=1" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${file_path}")
  etag=$(echo "${chunk_resp}" | json_get 'data.data.etag')

  curl -sS -X POST "${API_URL}/files/${file_id}/complete" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"uploadId\":\"${upload_id}\",\"parts\":[{\"partNumber\":1,\"etag\":$(printf '%s' "${etag}" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')}]}" >/dev/null

  # Poll status until READY
  local status="PROCESSING"
  for _ in $(seq 1 30); do
    local status_resp
    status_resp=$(curl -sS "${API_URL}/files/${file_id}/status" -H "Authorization: Bearer ${token}")
    status=$(echo "${status_resp}" | json_get 'data.data.status' 2>/dev/null || echo "PROCESSING")
    if [ "${status}" = "READY" ]; then
      break
    fi
    if [ "${status}" = "FAILED" ]; then
      echo "Conversion failed for ${file_name}: ${status_resp}" >&2
      return 1
    fi
    sleep 0.5
  done

  if [ "${status}" != "READY" ]; then
    echo "Timed out waiting for READY on ${file_name} (last status: ${status})" >&2
    return 1
  fi

  echo "${file_id}|${version_id}"
}

echo "Testing Cadline Session 7 Smart Measurement system against ${API_URL}"
echo "------------------------------------------------------------"

# 1. Run pure geometry unit tests
if npx tsx --test apps/web/src/lib/geometry/*.test.ts >/dev/null; then
  step_pass "1. Geometry unit tests (planarRegions, edgeLoops, cylinders, measurements)"
else
  step_fail "1. Geometry unit tests" "One or more unit tests failed"
  exit 1
fi

# 1b. Seed STEP fixture (read by apps/api/prisma/seed.ts) converts via OCCT to a 50 mm cube
SEED_STEP_OUT=$(cd "$(dirname "$0")/../apps/api" && node_modules/.bin/tsx -e "import('./src/lib/proceduralGlb.ts').then(async (m) => { const io = new (await import('@gltf-transform/core')).NodeIO(); const a = await m.convertUploadedBuffer(require('fs').readFileSync('../../scripts/seed-models/cube-50mm.step'), 'cube-50mm.step'); const d = await io.readBinary(new Uint8Array(a.glbBuffer)); const p = d.getRoot().listAccessors().find((x) => x.getType() === 'VEC3'); console.log(p.getMax([]).map((v, i) => v - p.getMin([])[i]).join(',')); })" 2>&1 | tail -1)
if [ "${SEED_STEP_OUT}" = "50,50,50" ]; then
  step_pass "1b. Seed fixture cube-50mm.step converts via OCCT to 50 x 50 x 50 mm"
else
  step_fail "1b. Seed fixture cube-50mm.step" "${SEED_STEP_OUT}"
fi

# 2. Login as demo admin
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

# 3. Get seeded project
PROJECTS_RESP=$(curl -sS "${API_URL}/projects?page=1&pageSize=10" -H "Authorization: Bearer ${TOKEN}")
PROJECT_ID=$(echo "${PROJECTS_RESP}" | json_get 'data.data.items[0].id' 2>/dev/null || true)
if [ -n "${PROJECT_ID}" ]; then
  step_pass "3. GET seeded project (${PROJECT_ID})"
else
  step_fail "3. GET seeded project" "${PROJECTS_RESP}"
  exit 1
fi

# 4. Upload cube-50mm.stl & plate-with-hole.stl
CUBE_META=$(upload_and_wait_ready "${PROJECT_ID}" "scripts/seed-models/cube-50mm.stl" "cube-50mm.stl" "${TOKEN}")
CUBE_FILE_ID="${CUBE_META%|*}"
CUBE_VER_ID="${CUBE_META#*|}"
step_pass "4. Uploaded & converted cube-50mm.stl (${CUBE_FILE_ID})"

PLATE_META=$(upload_and_wait_ready "${PROJECT_ID}" "scripts/seed-models/plate-with-hole.stl" "plate-with-hole.stl" "${TOKEN}")
PLATE_FILE_ID="${PLATE_META%|*}"
PLATE_VER_ID="${PLATE_META#*|}"
step_pass "5. Uploaded & converted plate-with-hole.stl (${PLATE_FILE_ID})"

# 6. Fetch converted GLB URLs and verify real geometry extraction + analytic measurements
CUBE_GLB_URL=$(curl -sS "${API_URL}/files/${CUBE_FILE_ID}/glb" -H "Authorization: Bearer ${TOKEN}" | json_get 'data.data.url')
PLATE_GLB_URL=$(curl -sS "${API_URL}/files/${PLATE_FILE_ID}/glb" -H "Authorization: Bearer ${TOKEN}" | json_get 'data.data.url')

# Normalize relative GLB URLs against BASE_ORIGIN
[[ "${CUBE_GLB_URL}" = /* ]] && CUBE_GLB_URL="${BASE_ORIGIN}${CUBE_GLB_URL}"
[[ "${PLATE_GLB_URL}" = /* ]] && PLATE_GLB_URL="${BASE_ORIGIN}${PLATE_GLB_URL}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT
curl -sS -H "Authorization: Bearer ${TOKEN}" "${CUBE_GLB_URL}" -o "${TMP_DIR}/cube.glb"
curl -sS -H "Authorization: Bearer ${TOKEN}" "${PLATE_GLB_URL}" -o "${TMP_DIR}/plate.glb"

# Verify GLB headers are valid glTF binary AND verify geometry extraction on both models
VERIFY_JSON=$(npx tsx -e '
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  buildTriangleMeshDataFromRawTriangles,
  parseStlBufferToTriangleMeshData,
  extractFeaturesFromPartMeshes,
  distancePlanePlane,
  anglePlanePlane,
  featureToMeasurementReference,
  minWallBetween,
  toFeatureCachePayload,
} from "./apps/web/src/lib/geometry/index.ts";

// Parse glTF-binary (GLB) mesh triangles directly so we validate the ACTUAL converted GLB bytes!
function parseGlbToTriangleMesh(glbPath: string, partId: string) {
  const buf = fs.readFileSync(glbPath);
  assert.equal(buf.toString("ascii", 0, 4), "glTF", "Converted file must have glTF magic header");
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const binOffset = 20 + jsonLen + 8;
  const binBuf = buf.subarray(binOffset);

  const raw: number[] = [];
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const posView = gltf.bufferViews[posAcc.bufferView];
      const posStart = (posView.byteOffset ?? 0) + (posAcc.byteOffset ?? 0);
      const posStride = posView.byteStride && posView.byteStride > 0 ? posView.byteStride : 12;
      const readPos = (vi: number): [number, number, number] => {
        const off = posStart + vi * posStride;
        return [
          binBuf.readFloatLE(off),
          binBuf.readFloatLE(off + 4),
          binBuf.readFloatLE(off + 8),
        ];
      };

      if (prim.indices !== undefined) {
        const idxAcc = gltf.accessors[prim.indices];
        const idxView = gltf.bufferViews[idxAcc.bufferView];
        const idxStart = (idxView.byteOffset ?? 0) + (idxAcc.byteOffset ?? 0);
        const getIdx = (k: number) =>
          idxAcc.componentType === 5121
            ? binBuf.readUInt8(idxStart + k)
            : idxAcc.componentType === 5123
              ? binBuf.readUInt16LE(idxStart + k * 2)
              : binBuf.readUInt32LE(idxStart + k * 4);
        for (let k = 0; k < idxAcc.count; k++) {
          const [x, y, z] = readPos(getIdx(k));
          raw.push(x, y, z);
        }
      } else {
        for (let k = 0; k < posAcc.count; k++) {
          const [x, y, z] = readPos(k);
          raw.push(x, y, z);
        }
      }
    }
  }
  return buildTriangleMeshDataFromRawTriangles(raw, partId, partId);
}

// A. Cube 50mm assertions (from converted GLB)
const cubeMesh = parseGlbToTriangleMesh(process.argv[1], "cube-50mm");
const cubeIdx = extractFeaturesFromPartMeshes([cubeMesh]);
const cubeSum = cubeIdx.partSummaries[0];
const cubePart = cubeIdx.parts.get("cube-50mm")!;

for (const d of cubeSum.bboxDims) {
  assert.ok(Math.abs(d - 50) <= 0.1, `Cube bbox dim expected 50, got ${d}`);
}
assert.ok(Math.abs(cubeSum.volume - 125000) / 125000 <= 0.01, `Cube volume expected 125000+-1%, got ${cubeSum.volume}`);
assert.ok(Math.abs(cubeSum.surfaceArea - 15000) / 15000 <= 0.01, `Cube area expected 15000+-1%, got ${cubeSum.surfaceArea}`);
assert.equal(cubePart.planes.length, 6, `Cube planes expected 6, got ${cubePart.planes.length}`);

// Face-to-face opposite distance & perpendicular angle
let foundDist50 = false;
let foundAngle90 = false;
for (let i = 0; i < cubePart.planes.length; i++) {
  for (let j = i + 1; j < cubePart.planes.length; j++) {
    const a = featureToMeasurementReference(cubeIdx.featureById.get(cubePart.planes[i].id)!);
    const b = featureToMeasurementReference(cubeIdx.featureById.get(cubePart.planes[j].id)!);
    const res = distancePlanePlane(a, b);
    if (res.parallel && Math.abs(res.measurement.value - 50) <= 0.1) foundDist50 = true;
    const ang = anglePlanePlane(a, b);
    if (Math.abs(ang.value - 90) <= 0.1) foundAngle90 = true;
  }
}
assert.ok(foundDist50, "Expected opposite cube face distance 50.00 +- 0.1");
assert.ok(foundAngle90, "Expected perpendicular cube face angle 90.0 +- 0.1 deg");

// B. Plate with 10mm hole assertions (from converted GLB)
const plateMesh = parseGlbToTriangleMesh(process.argv[2], "plate-with-hole");
const plateIdx = extractFeaturesFromPartMeshes([plateMesh]);
const plateSum = plateIdx.partSummaries[0];
const platePart = plateIdx.parts.get("plate-with-hole")!;

const sortedDims = [...plateSum.bboxDims].sort((a, b) => a - b);
assert.ok(Math.abs(sortedDims[0] - 10) <= 0.1 && Math.abs(sortedDims[1] - 50) <= 0.1 && Math.abs(sortedDims[2] - 50) <= 0.1, `Plate bbox expected 50x50x10, got ${plateSum.bboxDims}`);
assert.ok(platePart.circles.length >= 2, `Expected >=2 hole rim circles, got ${platePart.circles.length}`);
assert.ok(Math.abs(platePart.circles[0].diameter - 10) <= 0.2, `Circle hole dia expected 10+-0.2, got ${platePart.circles[0].diameter}`);
assert.ok(platePart.cylinders.length >= 1, `Expected >=1 cylindrical bore, got ${platePart.cylinders.length}`);
assert.ok(Math.abs(platePart.cylinders[0].diameter - 10) <= 0.2, `Cylinder bore dia expected 10+-0.2, got ${platePart.cylinders[0].diameter}`);
assert.equal(platePart.cylinders[0].isConcave, true, "Through-hole bore should be concave");

const plateWall = minWallBetween(plateMesh, plateMesh);
assert.ok(plateWall && Math.abs(plateWall.value - 10) <= 0.2, `Plate min wall expected 10+-0.2, got ${plateWall?.value}`);

// Output cache payload for step 7
process.stdout.write(JSON.stringify(toFeatureCachePayload(plateIdx)));
' "${TMP_DIR}/cube.glb" "${TMP_DIR}/plate.glb")

if [ -n "${VERIFY_JSON}" ]; then
  step_pass "6. Converted GLB geometry & L1/L2 feature verification (cube 50mm + plate-with-hole ⌀10mm)"
else
  step_fail "6. Converted GLB geometry verification" "Verification returned empty payload"
  exit 1
fi

# 7. Feature cache GET (miss) -> POST -> GET (hit) round-trip
FEAT_MISS=$(curl -sS "${API_URL}/files/${PLATE_FILE_ID}/features?versionId=${PLATE_VER_ID}" \
  -H "Authorization: Bearer ${TOKEN}")
if echo "${FEAT_MISS}" | json_get 'data.success === true && data.data.cached === false' >/dev/null 2>&1; then
  step_pass "7a. GET /files/${PLATE_FILE_ID}/features initially uncached (cached=false)"
else
  step_fail "7a. GET /files/${PLATE_FILE_ID}/features initial miss" "${FEAT_MISS}"
  exit 1
fi

FEAT_POST=$(curl -sS -X POST "${API_URL}/files/${PLATE_FILE_ID}/features?versionId=${PLATE_VER_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${VERIFY_JSON}")
if echo "${FEAT_POST}" | json_get 'data.success === true && data.data.cached === true && data.data.data.features.length >= 9' >/dev/null 2>&1; then
  step_pass "7b. POST /files/${PLATE_FILE_ID}/features stored extracted features"
else
  step_fail "7b. POST /files/${PLATE_FILE_ID}/features" "${FEAT_POST}"
  exit 1
fi

FEAT_HIT=$(curl -sS "${API_URL}/files/${PLATE_FILE_ID}/features?versionId=${PLATE_VER_ID}" \
  -H "Authorization: Bearer ${TOKEN}")
if echo "${FEAT_HIT}" | json_get 'data.success === true && data.data.cached === true && data.data.data.features.length >= 9' >/dev/null 2>&1; then
  step_pass "7c. GET /files/${PLATE_FILE_ID}/features cache hit verified"
else
  step_fail "7c. GET /files/${PLATE_FILE_ID}/features cache hit" "${FEAT_HIT}"
  exit 1
fi

# 8. SmartMeasurement POST -> GET -> PATCH -> DELETE round-trip
SMART_CREATE=$(curl -sS -X POST "${API_URL}/files/${PLATE_FILE_ID}/measurements" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"versionId\": \"${PLATE_VER_ID}\",
    \"type\": \"DIAMETER\",
    \"value\": 10.0,
    \"unit\": \"mm\",
    \"points\": {
      \"smart\": {
        \"id\": \"sm_dia_test\",
        \"kind\": \"diameter\",
        \"value\": 10.0,
        \"unit\": \"mm\",
        \"references\": [
          {
            \"kind\": \"cylinder\",
            \"partId\": \"plate-with-hole\",
            \"featureId\": \"cyl:plate-with-hole:0\",
            \"position\": [0, 0, 5],
            \"axis\": [0, 0, 1],
            \"radius\": 5.0,
            \"length\": 10.0,
            \"label\": \"Bore ⌀10.00 × 10.0 mm\"
          }
        ],
        \"anchor\": [0, 0, 5],
        \"lineStart\": [-5, 0, 5],
        \"lineEnd\": [5, 0, 5],
        \"axis\": [0, 0, 1],
        \"radius\": 5.0,
        \"label\": \"Center Through-Hole\",
        \"createdAt\": \"2026-11-20T07:00:00.000Z\"
      },
      \"coordinates\": [
        {\"x\": -5, \"y\": 0, \"z\": 5},
        {\"x\": 5, \"y\": 0, \"z\": 5}
      ]
    }
  }")

MSR_ID=$(echo "${SMART_CREATE}" | json_get 'data.data.id' 2>/dev/null || true)
if [ -n "${MSR_ID}" ]; then
  step_pass "8a. POST SmartMeasurement (${MSR_ID})"
else
  step_fail "8a. POST SmartMeasurement" "${SMART_CREATE}"
  exit 1
fi

SMART_LIST=$(curl -sS "${API_URL}/files/${PLATE_FILE_ID}/measurements?versionId=${PLATE_VER_ID}" \
  -H "Authorization: Bearer ${TOKEN}")
if echo "${SMART_LIST}" | json_get "data.data.some(m => m.id === '${MSR_ID}' && m.points.smart.kind === 'diameter' && Math.abs(m.value - 10) < 0.01)" >/dev/null 2>&1; then
  step_pass "8b. GET SmartMeasurement round-trip verified"
else
  step_fail "8b. GET SmartMeasurement round-trip" "${SMART_LIST}"
  exit 1
fi

SMART_PATCH=$(curl -sS -X PATCH "${API_URL}/measurements/${MSR_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"value\": 0.3937,
    \"unit\": \"in\",
    \"points\": {
      \"smart\": {
        \"id\": \"${MSR_ID}\",
        \"kind\": \"diameter\",
        \"value\": 0.3937,
        \"unit\": \"in\",
        \"references\": [
          {
            \"kind\": \"cylinder\",
            \"partId\": \"plate-with-hole\",
            \"position\": [0, 0, 5],
            \"axis\": [0, 0, 1],
            \"radius\": 5.0
          }
        ],
        \"anchor\": [0, 0, 5],
        \"label\": \"M10 Clearance Bore\",
        \"createdAt\": \"2026-11-20T07:00:00.000Z\"
      }
    }
  }")
if echo "${SMART_PATCH}" | json_get "data.success === true && data.data.unit === 'in' && data.data.points.smart.label === 'M10 Clearance Bore'" >/dev/null 2>&1; then
  step_pass "8c. PATCH /measurements/${MSR_ID} label rename + unit conversion (mm -> in)"
else
  step_fail "8c. PATCH /measurements/${MSR_ID}" "${SMART_PATCH}"
  exit 1
fi

SMART_DEL=$(curl -sS -X DELETE "${API_URL}/measurements/${MSR_ID}" \
  -H "Authorization: Bearer ${TOKEN}")
if echo "${SMART_DEL}" | json_get 'data.success === true && data.data.deleted === true' >/dev/null 2>&1; then
  step_pass "8d. DELETE /measurements/${MSR_ID} cleanup verified"
else
  step_fail "8d. DELETE /measurements/${MSR_ID}" "${SMART_DEL}"
  exit 1
fi

echo "------------------------------------------------------------"
echo "Session 7 measurement tests complete: ${PASS_COUNT} passed, ${FAIL_COUNT} failed."
if [ "${FAIL_COUNT}" -gt 0 ]; then
  exit 1
fi
