#!/bin/bash
# Run TLC model checker on a .tla file.
# Usage: tla-model-check.sh <spec.tla> [config.cfg]
# Defaults config to <spec-basename>.cfg in the same directory as the spec.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=find-tla-tools.sh
source "$SCRIPT_DIR/find-tla-tools.sh"

SPEC="${1:-}"
if [ -z "$SPEC" ]; then
    echo "Usage: $(basename "$0") <spec.tla> [config.cfg]" >&2
    exit 1
fi

SPEC_ABS="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
SPEC_DIR="$(dirname "$SPEC_ABS")"
SPEC_BASE="$(basename "$SPEC_ABS")"
CFG="${2:-${SPEC_BASE%.tla}.cfg}"

echo "Model checking: $SPEC_BASE (config: $CFG)"
cd "$SPEC_DIR"
"$JAVA" -cp "$TLA_TOOLS" tlc2.TLC -config "$CFG" "$SPEC_BASE"
