#!/bin/bash
# Run TLA+ syntax checker (SANY) on a .tla file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=find-tla-tools.sh
source "$SCRIPT_DIR/find-tla-tools.sh"

SPEC="${1:-}"
if [ -z "$SPEC" ]; then
    echo "Usage: $(basename "$0") <spec.tla>" >&2
    exit 1
fi

SPEC_ABS="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
SPEC_DIR="$(dirname "$SPEC_ABS")"
SPEC_BASE="$(basename "$SPEC_ABS")"

echo "Checking syntax: $SPEC_BASE"
cd "$SPEC_DIR"
"$JAVA" -cp "$TLA_TOOLS" tla2sany.SANY "$SPEC_BASE"
