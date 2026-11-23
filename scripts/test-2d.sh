#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000/api/v1}"
DEMO_EMAIL="${DEMO_EMAIL:-admin@demo.local}"
DEMO_PASSWORD="${DEMO_PASSWORD:-Password123!}"

echo "==> Cadline Session 4 — 2D Drawing Viewer Smoke Test"
echo "    API_URL=${API_URL}"

# 1. Authenticate
LOGIN_RESP="$(curl -sS -X POST "${API_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${DEMO_EMAIL}\",\"password\":\"${DEMO_PASSWORD}\"}")"

TOKEN="$(printf '%s' "$LOGIN_RESP" | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!data.success || !data.data?.tokens?.accessToken) {
    console.error("Login failed:", data);
    process.exit(1);
  }
  process.stdout.write(data.data.tokens.accessToken);
')"
echo "[PASS] Authenticated as ${DEMO_EMAIL}"

# 2. Discover seeded DXF, PDF, and 3D files
PROJECTS_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/projects?page=1&pageSize=10")"
FIRST_PROJECT_ID="$(printf '%s' "$PROJECTS_RESP" | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const items = data.data?.items ?? data.data ?? [];
  if (!items.length) { console.error("No projects found"); process.exit(1); }
  process.stdout.write(items[0].id);
')"

FILES_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files?projectId=${FIRST_PROJECT_ID}")"
eval "$(printf '%s' "$FILES_RESP" | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const items = data.data?.items ?? data.data ?? [];
  const dxf = items.find((f) => f.extension.toLowerCase() === "dxf");
  const pdf = items.find((f) => f.extension.toLowerCase() === "pdf");
  const dwg = items.find((f) => f.extension.toLowerCase() === "dwg");
  const model3d = items.find((f) => ["glb","gltf","stl","step","stp","obj"].includes(f.extension.toLowerCase()));
  if (!dxf || !pdf || !model3d) {
    console.error("Missing seeded files:", { dxf: !!dxf, pdf: !!pdf, model3d: !!model3d });
    process.exit(1);
  }
  console.log(`DXF_FILE_ID=${JSON.stringify(dxf.id)}`);
  console.log(`PDF_FILE_ID=${JSON.stringify(pdf.id)}`);
  console.log(`DWG_FILE_ID=${JSON.stringify(dwg ? dwg.id : "")}`);
  console.log(`MODEL3D_FILE_ID=${JSON.stringify(model3d.id)}`);
')"
echo "[PASS] Found seeded DXF (${DXF_FILE_ID}), PDF (${PDF_FILE_ID}), and 3D (${MODEL3D_FILE_ID})"

# Fetch DXF versionId
DXF_DETAIL="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${DXF_FILE_ID}")"
DXF_VERSION_ID="$(printf '%s' "$DXF_DETAIL" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const v = d.data?.versions?.[0]?.id;
  if (!v) { console.error("Missing DXF versionId"); process.exit(1); }
  process.stdout.write(v);
')"

# 3. GET /2d/scene on DXF — must have >= 10 entities and >= 4 layers
DXF_SCENE_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${DXF_FILE_ID}/2d/scene")"
printf '%s' "$DXF_SCENE_RESP" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success || d.data?.mode !== "2D_DXF") {
    console.error("Unexpected DXF scene response:", d);
    process.exit(1);
  }
  const entCount = d.data.scene?.entities?.length ?? 0;
  const layerCount = d.data.layers?.length ?? 0;
  if (entCount < 10 || layerCount < 4) {
    console.error(`DXF scene too small: entities=${entCount}, layers=${layerCount}`);
    process.exit(1);
  }
  console.log(`[PASS] GET /2d/scene (DXF): ${entCount} entities across ${layerCount} layers, units=${d.data.bounds?.units}`);
'

# 4. GET /2d/scene on PDF — must return pageCount >= 1 + GET /2d/page/1 returns valid URL
PDF_SCENE_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${PDF_FILE_ID}/2d/scene")"
printf '%s' "$PDF_SCENE_RESP" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success || d.data?.mode !== "2D_PDF") {
    console.error("Unexpected PDF scene response:", d);
    process.exit(1);
  }
  const pageCount = d.data.pageManifest?.pageCount ?? 0;
  if (pageCount < 1) {
    console.error("PDF pageCount < 1:", d.data.pageManifest);
    process.exit(1);
  }
  console.log(`[PASS] GET /2d/scene (PDF): pageCount=${pageCount}, pageSize=${d.data.pageManifest.pageSize.width}x${d.data.pageManifest.pageSize.height}`);
'

PDF_PAGE_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${PDF_FILE_ID}/2d/page/1")"
printf '%s' "$PDF_PAGE_RESP" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success || !d.data?.url) {
    console.error("Unexpected PDF page response:", d);
    process.exit(1);
  }
  console.log(`[PASS] GET /2d/page/1 returned URL: ${d.data.url}`);
'

# 5. POST 2D distance measurement and read it back
MSR_CREATE_RESP="$(curl -sS -X POST "${API_URL}/files/${DXF_FILE_ID}/measurements" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"versionId\": \"${DXF_VERSION_ID}\",
    \"type\": \"DISTANCE\",
    \"value\": 120.0,
    \"unit\": \"mm\",
    \"points\": {
      \"points2d\": [{\"x\": 15, \"y\": 15}, {\"x\": 135, \"y\": 15}],
      \"sheet\": \"dxf\"
    }
  }")"

MSR_ID="$(printf '%s' "$MSR_CREATE_RESP" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success || !d.data?.id || !Array.isArray(d.data?.points?.points2d)) {
    console.error("2D measurement creation failed:", d);
    process.exit(1);
  }
  process.stdout.write(d.data.id);
')"

MSR_LIST_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${DXF_FILE_ID}/measurements?versionId=${DXF_VERSION_ID}")"
printf '%s' "$MSR_LIST_RESP" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const found = (d.data ?? []).find((m) => m.id === '${MSR_ID}');
  if (!found || !Array.isArray(found.points?.points2d) || found.points.points2d.length !== 2) {
    console.error('Created 2D measurement not found in list:', d);
    process.exit(1);
  }
  console.log('[PASS] POST + GET 2D distance measurement (${MSR_ID}):', found.value, found.unit);
"

# 6. POST 2D pin annotation (anchor.kind === '2d') and read it back
ANN_CREATE_RESP="$(curl -sS -X POST "${API_URL}/files/${DXF_FILE_ID}/annotations" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"versionId\": \"${DXF_VERSION_ID}\",
    \"type\": \"PIN\",
    \"label\": \"Smoke-test 2D pin\",
    \"payload\": {
      \"anchor\": {
        \"kind\": \"2d\",
        \"sheet\": \"dxf\",
        \"x\": 75,
        \"y\": 50,
        \"view\": { \"scale\": 3.5, \"offsetX\": 120, \"offsetY\": 80 }
      },
      \"shape\": {
        \"shapeType\": \"pin\",
        \"color\": \"#0b5fff\",
        \"points\": [{\"x\": 75, \"y\": 50}]
      }
    }
  }")"

ANN_ID="$(printf '%s' "$ANN_CREATE_RESP" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success || !d.data?.id || d.data?.payload?.anchor?.kind !== "2d") {
    console.error("2D annotation creation failed:", d);
    process.exit(1);
  }
  process.stdout.write(d.data.id);
')"

ANN_LIST_RESP="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${DXF_FILE_ID}/annotations?versionId=${DXF_VERSION_ID}")"
printf '%s' "$ANN_LIST_RESP" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const found = (d.data ?? []).find((a) => a.id === '${ANN_ID}');
  if (!found || found.payload?.anchor?.kind !== '2d') {
    console.error('Created 2D annotation not found in list:', d);
    process.exit(1);
  }
  console.log('[PASS] POST + GET 2D pin annotation (${ANN_ID}): anchor.kind=2d');
"

# 7. GET /2d/scene on 3D file must return 400 with error.code === 'NOT_2D'
NOT2D_STATUS="$(curl -sS -o /tmp/cadline_not2d.json -w "%{http_code}" \
  -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${MODEL3D_FILE_ID}/2d/scene")"
if [ "$NOT2D_STATUS" != "400" ]; then
  echo "[FAIL] Expected HTTP 400 for 3D file /2d/scene, got ${NOT2D_STATUS}"
  cat /tmp/cadline_not2d.json
  exit 1
fi
node -e '
  const d = JSON.parse(require("fs").readFileSync("/tmp/cadline_not2d.json", "utf8"));
  if (d.error?.code !== "NOT_2D") {
    console.error("Expected error.code === NOT_2D, got:", d);
    process.exit(1);
  }
  console.log("[PASS] GET /2d/scene on 3D file returned 400 NOT_2D");
'

# 8. Optional check: DWG returns 422 with proprietary format guidance
if [ -n "$DWG_FILE_ID" ]; then
  DWG_STATUS="$(curl -sS -o /tmp/cadline_dwg.json -w "%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" "${API_URL}/files/${DWG_FILE_ID}/2d/scene")"
  if [ "$DWG_STATUS" != "422" ]; then
    echo "[FAIL] Expected HTTP 422 for DWG file /2d/scene, got ${DWG_STATUS}"
    cat /tmp/cadline_dwg.json
    exit 1
  fi
  node -e '
    const d = JSON.parse(require("fs").readFileSync("/tmp/cadline_dwg.json", "utf8"));
    if (!String(d.error?.message || "").includes("DWG is a proprietary format")) {
      console.error("Unexpected DWG error message:", d);
      process.exit(1);
    }
    console.log("[PASS] GET /2d/scene on DWG file returned 422 with conversion guidance");
  '
fi

# Clean up temporary smoke-test records
curl -sS -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}/measurements/${MSR_ID}" >/dev/null
curl -sS -X DELETE -H "Authorization: Bearer ${TOKEN}" "${API_URL}/annotations/${ANN_ID}" >/dev/null
rm -f /tmp/cadline_not2d.json /tmp/cadline_dwg.json

echo "==> All Session 4 2D smoke tests PASSED!"
