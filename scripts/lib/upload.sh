#!/usr/bin/env bash
# Shared upload helper: performs the same S3 multipart flow as the web client
# (apps/web/src/components/UploadDropzone.tsx). Source it (after lib/auth.sh), then:
#
#   cadline_upload <project_id> <file_path> [file_name] [mime_type]
#
# 1. POST /files/init           -> uploadId + one presigned part URL per chunk
# 2. PUT each chunk directly to its presigned S3 URL, collecting the ETag header
# 3. POST /files/:id/complete   -> queues conversion
# 4. polls GET /files/:id/status until READY (fails on FAILED or timeout)
#
# Prints "<fileId>|<versionId>" on success. Uses CADLINE_TOKEN for API calls;
# presigned S3 requests carry no Authorization header (S3 rejects double auth).
# Env: API_URL, CADLINE_UPLOAD_CHUNK_SIZE (default 5 MiB, the S3 part minimum),
#      CADLINE_UPLOAD_TIMEOUT_S (default 90).

: "${API_URL:=http://localhost:4000/api/v1}"

cadline_upload() {
  local project_id="$1" file_path="$2"
  local file_name="${3:-$(basename "$2")}" mime_type="${4:-application/octet-stream}"
  local chunk_size="${CADLINE_UPLOAD_CHUNK_SIZE:-5242880}"
  local timeout_s="${CADLINE_UPLOAD_TIMEOUT_S:-90}"

  if [ -z "${CADLINE_TOKEN:-}" ]; then
    echo "[upload] CADLINE_TOKEN is not set; call cadline_login first" >&2
    return 1
  fi
  if [ ! -f "${file_path}" ]; then
    echo "[upload] no such file: ${file_path}" >&2
    return 1
  fi

  local size_bytes work init_body init_resp
  size_bytes=$(wc -c < "${file_path}" | tr -d ' ')
  work=$(mktemp -d)

  init_body=$(PROJECT_ID="${project_id}" FILE_NAME="${file_name}" MIME="${mime_type}" \
    SIZE="${size_bytes}" CHUNK="${chunk_size}" node -e '
      process.stdout.write(JSON.stringify({
        projectId: process.env.PROJECT_ID, fileName: process.env.FILE_NAME,
        mimeType: process.env.MIME, sizeBytes: Number(process.env.SIZE),
        chunkSize: Number(process.env.CHUNK),
      }))')
  init_resp=$(curl -sS -X POST "${API_URL}/files/init" \
    -H "Authorization: Bearer ${CADLINE_TOKEN}" -H "Content-Type: application/json" -d "${init_body}")
  printf '%s' "${init_resp}" > "${work}/init.json"

  local file_id version_id upload_id part_count
  file_id=$(cadline_json_field 'data.data.file.id' < "${work}/init.json") &&
    version_id=$(cadline_json_field 'data.data.version.id' < "${work}/init.json") &&
    upload_id=$(cadline_json_field 'data.data.uploadId' < "${work}/init.json") &&
    part_count=$(cadline_json_field 'data.data.presignedUrls.length' < "${work}/init.json") || {
      echo "[upload] init failed for ${file_name}: ${init_resp}" >&2
      rm -rf "${work}"
      return 1
    }

  local parts_file="${work}/parts.ndjson" i url status etag
  : > "${parts_file}"
  for ((i = 1; i <= part_count; i++)); do
    url=$(cadline_json_field "data.data.presignedUrls.find(p => p.partNumber === ${i}).url" < "${work}/init.json")
    # Slice chunk i (1-based) without loading the file into memory.
    tail -c +$(( (i - 1) * chunk_size + 1 )) "${file_path}" | head -c "${chunk_size}" > "${work}/part"
    status=$(curl -sS -X PUT "${url}" --data-binary "@${work}/part" \
      -D "${work}/headers" -o "${work}/body" -w '%{http_code}')
    etag=$(tr -d '\r' < "${work}/headers" | awk -F': ' 'tolower($1) == "etag" { gsub(/"/, "", $2); print $2 }' | tail -1)
    if [ "${status}" != "200" ] || [ -z "${etag}" ]; then
      echo "[upload] PUT part ${i}/${part_count} -> HTTP ${status}, etag='${etag}': $(cat "${work}/body")" >&2
      rm -rf "${work}"
      return 1
    fi
    printf '{"partNumber":%d,"etag":"%s"}\n' "${i}" "${etag}" >> "${parts_file}"
  done

  local complete_body complete_resp
  complete_body=$(UPLOAD_ID="${upload_id}" node -e '
    const parts = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
    process.stdout.write(JSON.stringify({ uploadId: process.env.UPLOAD_ID, parts }))' "${parts_file}")
  complete_resp=$(curl -sS -X POST "${API_URL}/files/${file_id}/complete" \
    -H "Authorization: Bearer ${CADLINE_TOKEN}" -H "Content-Type: application/json" -d "${complete_body}")
  if ! printf '%s' "${complete_resp}" | cadline_json_field 'data.success === true || undefined' >/dev/null; then
    echo "[upload] complete failed for ${file_name}: ${complete_resp}" >&2
    rm -rf "${work}"
    return 1
  fi
  rm -rf "${work}"

  local deadline=$(( $(date +%s) + timeout_s )) state="PROCESSING" status_resp
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    status_resp=$(curl -sS "${API_URL}/files/${file_id}/status" -H "Authorization: Bearer ${CADLINE_TOKEN}")
    state=$(printf '%s' "${status_resp}" | cadline_json_field 'data.data.status' 2>/dev/null || echo "PROCESSING")
    case "${state}" in
      READY) echo "${file_id}|${version_id}"; return 0 ;;
      FAILED) echo "[upload] conversion failed for ${file_name}: ${status_resp}" >&2; return 1 ;;
    esac
    sleep 1
  done
  echo "[upload] timed out after ${timeout_s}s waiting for ${file_name} (last status: ${state})" >&2
  return 1
}
