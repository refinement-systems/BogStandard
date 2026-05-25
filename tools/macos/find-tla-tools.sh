# Source this file to export TLA_TOOLS (tlatools plugin dir) and JAVA (bundled java binary).
# Works when sourced from bash/zsh; return 1 on failure so callers can set -e.

_APP="/Applications/TLA+ Toolbox.app"

TLA_TOOLS="$(find "$_APP/Contents/Eclipse/plugins" \
  -maxdepth 1 \
  -name 'org.lamport.tlatools_*' \
  | head -n 1)"

if [ -z "$TLA_TOOLS" ]; then
  echo "ERROR: TLA+ Toolbox not found at '$_APP'" >&2
  return 1 2>/dev/null || exit 1
fi

JAVA="$(find "$_APP" \
  -type f \
  -path '*/bin/java' \
  -perm -111 \
  -print \
  | head -n 1)"

if [ -z "$JAVA" ]; then
  echo "ERROR: Bundled Java not found in TLA+ Toolbox" >&2
  return 1 2>/dev/null || exit 1
fi

unset _APP
export TLA_TOOLS
export JAVA
