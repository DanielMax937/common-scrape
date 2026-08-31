#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_ROOT="$(cd "${PROJECT_ROOT}/../../.." && pwd)"

# shellcheck source=../../../config/m4-runtime.sh
source "${MIGRATION_ROOT}/config/m4-runtime.sh"
cd "$PROJECT_ROOT"

if [[ $# -eq 0 ]]; then
  echo "Usage: $(basename "$0") <npm-script> [script arguments ...]" >&2
  echo "Example: $(basename "$0") workflow:macro-news --dry-run" >&2
  exit 64
fi

NPM_SCRIPT="$1"
shift
exec /opt/homebrew/bin/npm run "$NPM_SCRIPT" -- "$@"
