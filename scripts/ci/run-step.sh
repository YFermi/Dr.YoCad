#!/usr/bin/env bash
# CI helper: run a command, stream its output, and on failure also publish the
# last lines as a GitHub Actions error annotation, so the cause shows on the run
# summary page (readable without downloading logs).
#
#   bash scripts/ci/run-step.sh "<title>" <command> [args...]
set -uo pipefail

title="$1"; shift
log="$(mktemp)"

"$@" 2>&1 | tee "${log}"
code=${PIPESTATUS[0]}

if [ "${code}" -ne 0 ]; then
  # Annotation bodies must be single-line: escape %, CR and LF per the workflow-command spec.
  tail -n 60 "${log}" | tail -c 6000 |
    sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk 'BEGIN { ORS = "%0A" } { print }' > "${log}.tail"
  echo "::error title=${title} failed (exit ${code})::$(cat "${log}.tail")"
fi
rm -f "${log}" "${log}.tail"
exit "${code}"
