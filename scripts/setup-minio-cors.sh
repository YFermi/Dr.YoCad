#!/usr/bin/env bash
set -euo pipefail

# Configures MinIO bucket CORS so the browser (http://localhost:5173) can PUT
# directly to S3 presigned part URLs and read back the ETag response header.

MINIO_ALIAS="${MINIO_ALIAS:-cadline}"
MINIO_URL="${S3_ENDPOINT:-http://localhost:9000}"
MINIO_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
MINIO_SECRET_KEY="${S3_SECRET_KEY:-minioadmin123}"
BUCKET="${S3_BUCKET:-cadline-files}"
WEB_ORIGIN="${WEB_URL:-http://localhost:5173}"

CORS_FILE="$(mktemp)"
trap 'rm -f "$CORS_FILE"' EXIT

cat > "$CORS_FILE" <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": ["${WEB_ORIGIN}", "http://127.0.0.1:5173"],
      "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "x-amz-request-id", "x-amz-id-2"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF

echo "Configuring MinIO alias '${MINIO_ALIAS}' at ${MINIO_URL}..."
mc alias set "${MINIO_ALIAS}" "${MINIO_URL}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}"
mc mb --ignore-existing "${MINIO_ALIAS}/${BUCKET}"
mc cors set "${MINIO_ALIAS}/${BUCKET}" "${CORS_FILE}"

echo "CORS policy applied to ${MINIO_ALIAS}/${BUCKET}:"
mc cors list "${MINIO_ALIAS}/${BUCKET}"
