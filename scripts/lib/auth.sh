#!/usr/bin/env bash
# Shared login helper for Dr.Yo CAD shell scripts. Source it, then call:
#
#   cadline_login [email] [password]
#
# Logs in once per shell (cached by email) and exports:
#   CADLINE_TOKEN    access token for "Authorization: Bearer ..."
#   CADLINE_USER_ID  the user's id
# Returns non-zero (and prints the response) if login fails.
# Requires API_URL (defaults to the local Fastify API) plus curl and node.

: "${API_URL:=http://localhost:4000/api/v1}"

cadline_json_field() {
  # Reads JSON on stdin and prints the value at the given JS expression over `data`.
  node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const val = (${1});
    if (val === undefined || val === null) process.exit(1);
    process.stdout.write(typeof val === 'object' ? JSON.stringify(val) : String(val));
  "
}

cadline_login() {
  local email="${1:-admin@demo.local}"
  local password="${2:-Password123!}"

  if [ -n "${CADLINE_TOKEN:-}" ] && [ "${CADLINE_TOKEN_EMAIL:-}" = "${email}" ]; then
    return 0
  fi

  local body resp token user_id
  body=$(EMAIL="${email}" PASSWORD="${password}" node -e \
    'process.stdout.write(JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }))')
  resp=$(curl -sS -X POST "${API_URL}/auth/login" -H "Content-Type: application/json" -d "${body}") || {
    echo "[auth] POST ${API_URL}/auth/login failed (is the API running?)" >&2
    return 1
  }

  token=$(printf '%s' "${resp}" | cadline_json_field 'data.data.tokens.accessToken') || {
    echo "[auth] login as ${email} failed: ${resp}" >&2
    return 1
  }
  user_id=$(printf '%s' "${resp}" | cadline_json_field 'data.data.user.id' || true)

  export CADLINE_TOKEN="${token}"
  export CADLINE_TOKEN_EMAIL="${email}"
  export CADLINE_USER_ID="${user_id}"
}
