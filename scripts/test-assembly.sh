#!/usr/bin/env bash
# STEP assemblies and rejected formats, against the API:
#   1. gearbox-assembly.step converts READY with a nested tree:
#      GEARBOX > {HOUSING, SHAFT_ASSY > {SHAFT, GEAR, GEAR (2)}, COVER} (5 parts)
#   2. the GLB gives the uncolored parts distinct colors (the two GEAR instances share one)
#   3. a .sldprt uploaded through the API fails with the SolidWorks export guidance
#
#   API_URL=http://localhost:4000/api/v1 bash scripts/test-assembly.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"
: "${API_URL:=http://localhost:4000/api/v1}"
# shellcheck source=lib/auth.sh
source "${ROOT_DIR}/scripts/lib/auth.sh"
# shellcheck source=lib/upload.sh
source "${ROOT_DIR}/scripts/lib/upload.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }

echo "Testing Dr.Yo CAD assemblies and format rejection against ${API_URL}"
cadline_login admin@demo.local 'Password123!' || exit 1
PROJECT_ID="prj_demo_gearbox"

# --- 1. STEP assembly -> nested part tree ---------------------------------------
if RESULT=$(cadline_upload "${PROJECT_ID}" scripts/seed-models/gearbox-assembly.step "gearbox-assembly-$(date +%s).step" application/step); then
  FILE_ID="${RESULT%%|*}"
  pass "1. gearbox-assembly.step converted READY (${FILE_ID})"
else
  fail "1. gearbox-assembly.step conversion" "${RESULT:-upload failed}"
  echo "${PASS} passed, ${FAIL} failed"
  exit 1
fi

TREE=$(curl -sS "${API_URL}/files/${FILE_ID}/tree" -H "Authorization: Bearer ${CADLINE_TOKEN}")
SHAPE=$(printf '%s' "${TREE}" | cadline_json_field '(() => {
  const roots = data.data.partTree;
  const fmt = (n) => n.children.length ? `${n.name}{${n.children.map(fmt).join(",")}}` : n.name;
  return roots.map(fmt).join(",");
})()')
EXPECTED='GEARBOX{HOUSING,SHAFT_ASSY{SHAFT,GEAR,GEAR (2)},COVER}'
if [ "${SHAPE}" = "${EXPECTED}" ]; then
  pass "1b. part tree is nested: ${SHAPE}"
else
  fail "1b. part tree shape" "got '${SHAPE}', expected '${EXPECTED}'"
fi
LEAVES=$(printf '%s' "${TREE}" | cadline_json_field '(() => {
  const count = (n) => n.children.length ? n.children.reduce((s, c) => s + count(c), 0) : 1;
  return data.data.partTree.reduce((s, n) => s + count(n), 0);
})()')
[ "${LEAVES}" = "5" ] && pass "1c. 5 leaf parts" || fail "1c. leaf part count" "got ${LEAVES}, expected 5"

# --- 2. distinct per-part colors in the GLB ----------------------------------------
GLB_PATH=$(curl -sS "${API_URL}/files/${FILE_ID}/glb" -H "Authorization: Bearer ${CADLINE_TOKEN}" | cadline_json_field 'data.data.url')
API_ORIGIN="${API_URL%%/api/*}"
GLB_FILE=$(mktemp)
curl -sS "${API_ORIGIN}${GLB_PATH}" -o "${GLB_FILE}"
COLORS=$(node -e '
  const buf = require("fs").readFileSync(process.argv[1]);
  if (buf.toString("utf8", 0, 4) !== "glTF") { console.log("not-a-glb"); process.exit(0); }
  const json = JSON.parse(buf.toString("utf8", 20, 20 + buf.readUInt32LE(12)));
  const colorOf = (meshIdx) => {
    const mat = json.materials[json.meshes[meshIdx].primitives[0].material];
    return (mat.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1]).slice(0, 3).map((c) => c.toFixed(3)).join(",");
  };
  const byName = {};
  for (const n of json.nodes) if (n.mesh !== undefined) byName[n.name] = colorOf(n.mesh);
  const distinct = new Set(Object.values(byName)).size;
  console.log(JSON.stringify({ distinct, gearsShare: byName["GEAR"] === byName["GEAR (2)"], names: Object.keys(byName).sort() }));
' "${GLB_FILE}")
rm -f "${GLB_FILE}"
if printf '%s' "${COLORS}" | node -e 'const c = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(c.distinct === 4 && c.gearsShare ? 0 : 1)' 2>/dev/null; then
  pass "2. GLB colors: 4 distinct for 4 distinct parts, GEAR instances share one ${COLORS}"
else
  fail "2. GLB per-part colors" "${COLORS}"
fi

# --- 3. SolidWorks native via the API -> FAILED with guidance ------------------------
SW_FILE=$(mktemp)
printf 'not a real SolidWorks part' > "${SW_FILE}"
EXPECTED_MSG='SolidWorks native files (.sldprt/.sldasm) require a commercial converter. Export your file to STEP (.step) from SolidWorks, then upload that instead.'
SW_OUT=$(cadline_upload "${PROJECT_ID}" "${SW_FILE}" "bracket-$(date +%s).sldprt" application/octet-stream 2>&1)
SW_CODE=$?
rm -f "${SW_FILE}"
if [ "${SW_CODE}" -ne 0 ] && printf '%s' "${SW_OUT}" | grep -qF "${EXPECTED_MSG}"; then
  pass "3. .sldprt via API -> FAILED with the SolidWorks export guidance"
else
  fail "3. .sldprt rejection" "exit=${SW_CODE} ${SW_OUT}"
fi

echo
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
