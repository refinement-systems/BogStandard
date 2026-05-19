#!/usr/bin/env bash
# dispatch.sh — spawn N parallel BogStandard workers, one per eligible issue.
#
# Usage:
#   ./dispatch.sh [N] [-- pi-args...]
#   ./dispatch.sh --cleanup
#
#   N          Number of workers (default: 2)
#   pi-args    Extra flags forwarded to every pi invocation, e.g.:
#              -- --bs-plan-model openrouter/deepseek/deepseek-v4-flash
#
# Each worker gets its own git worktree and branch. Each worktree gets its own
# .bogstandard/config.json with a per-worker agent_id ("worker-${i}") so the
# workers hold distinct postgres locks against the shared database.
#
# --cleanup removes all bogstandard/worker-* branches and worktrees created
# by a previous dispatch run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_PATH="${SCRIPT_DIR}/agent/extensions/bogstandard"
BS_LIST_ELIGIBLE="${SCRIPT_DIR}/bin/bs-list-eligible"

# --- dependency checks -------------------------------------------------------

for cmd in git node npx tmux; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "error: $cmd is required but not found on PATH" >&2
        exit 1
    fi
done

REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
REPO_PARENT=$(dirname "$REPO_ROOT")
CONFIG_FILE="${REPO_ROOT}/.bogstandard/config.json"

# --- --cleanup mode ----------------------------------------------------------

if [[ "${1-}" == "--cleanup" ]]; then
    echo "Removing bogstandard worker worktrees..."
    git worktree list --porcelain \
        | awk '/^worktree /{print $2}' \
        | grep -F "${REPO_PARENT}/${REPO_NAME}-worker-" \
        | while read -r wt; do
            echo "  remove worktree: $wt"
            git worktree remove --force "$wt" 2>/dev/null || true
        done

    echo "Deleting bogstandard/worker-* branches..."
    git branch \
        | sed 's/^[* ]*//' \
        | grep '^bogstandard/worker-' \
        | while read -r br; do
            echo "  delete branch: $br"
            git branch -D "$br"
        done

    echo "Done."
    exit 0
fi

# --- parse arguments ---------------------------------------------------------

N=2
PI_ARGS=()

if [[ $# -gt 0 && "$1" != "--" ]]; then
    N="$1"
    shift
fi
if [[ $# -gt 0 && "$1" == "--" ]]; then
    shift
    PI_ARGS=("$@")
fi

if ! [[ "$N" =~ ^[0-9]+$ ]]; then
    echo "error: N must be a non-negative integer, got: $N" >&2
    exit 1
fi
if [[ "$N" -eq 0 ]]; then
    echo "No workers requested."
    exit 0
fi

# --- read parent config ------------------------------------------------------
# We need the database_url so we can stamp each worker config.json with the
# same connection. The agent_id is overridden per worker, so we ignore the
# parent's value here.

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "error: ${CONFIG_FILE} not found." >&2
    echo "From inside this project, run: ${SCRIPT_DIR}/bin/bs-setup --database-url <url>" >&2
    exit 1
fi

DATABASE_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')).database_url)")
STALE_TIMEOUT=$(node -e "const c=JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')); console.log(c.stale_lock_timeout_minutes ?? 60)")

if [[ -z "$DATABASE_URL" || "$DATABASE_URL" == "undefined" ]]; then
    echo "error: ${CONFIG_FILE} has no database_url" >&2
    exit 1
fi

# --- collect eligible issues -------------------------------------------------

ISSUES=$("$BS_LIST_ELIGIBLE" --limit "$N" 2>/dev/null || true)

if [[ -z "$ISSUES" ]]; then
    echo "No eligible issues found." >&2
    exit 1
fi

ACTUAL=$(echo "$ISSUES" | grep -c '[0-9]' || true)
if [[ "$ACTUAL" -lt "$N" ]]; then
    echo "Note: only $ACTUAL eligible issue(s) available (requested $N); spawning $ACTUAL worker(s)."
fi

# --- create worktrees and tmux session ---------------------------------------

SESSION="bogstandard-dispatch-$$"
tmux new-session -d -s "$SESSION"

i=1
first=1
while IFS= read -r issue_id; do
    [[ -z "$issue_id" ]] && continue

    WORKTREE="${REPO_PARENT}/${REPO_NAME}-worker-${i}"
    BRANCH="bogstandard/worker-${i}/issue-${issue_id}"
    WIN_NAME="worker-${i}:#${issue_id}"
    AGENT_ID="worker-${i}"

    echo "Worker $i: issue #${issue_id} → ${WORKTREE} (${BRANCH})"

    git worktree add -b "$BRANCH" "$WORKTREE" main

    # Write a per-worktree config: same database URL as the parent, but a
    # distinct agent_id so this worker holds its own postgres locks. The
    # .bogstandard directory is gitignored so it stays out of the worktree's
    # commit history.
    mkdir -p "${WORKTREE}/.bogstandard"
    cat > "${WORKTREE}/.bogstandard/config.json" <<EOF
{
  "database_url": "${DATABASE_URL}",
  "agent_id": "${AGENT_ID}",
  "stale_lock_timeout_minutes": ${STALE_TIMEOUT}
}
EOF

    # Build the pi invocation. --bs-issue-id pre-assigns the issue so workers
    # don't race for the auto-pick.
    CMD="pi -e '${EXT_PATH}' --bs-issue-id ${issue_id}"
    if [[ ${#PI_ARGS[@]} -gt 0 ]]; then
        CMD="${CMD} ${PI_ARGS[*]}"
    fi
    CMD="${CMD} /bogstandard"

    if [[ "$first" -eq 1 ]]; then
        tmux rename-window -t "${SESSION}:0" "$WIN_NAME"
        tmux send-keys -t "${SESSION}:0" "cd '${WORKTREE}' && ${CMD}" Enter
        first=0
    else
        tmux new-window -t "$SESSION" -n "$WIN_NAME" -c "$WORKTREE"
        tmux send-keys -t "$SESSION" "${CMD}" Enter
    fi

    i=$((i + 1))
done <<< "$ISSUES"

echo "Spawned $((i - 1)) worker(s) in tmux session '${SESSION}'."
echo "Detach with Ctrl-b d.  When done: ./dispatch.sh --cleanup"
if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$SESSION"
else
    tmux attach-session -t "$SESSION"
fi
