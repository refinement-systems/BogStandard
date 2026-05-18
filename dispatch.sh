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
# Each worker gets its own git worktree and branch. The .chainlink directory
# is symlinked from the main checkout into each worktree so all workers share
# the same issue database.
#
# --cleanup removes all bogstandard/worker-* branches and worktrees created
# by a previous dispatch run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_PATH="${SCRIPT_DIR}/agent/extensions/bogstandard"

# --- dependency checks -------------------------------------------------------

for cmd in git chainlink jq tmux; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "error: $cmd is required but not found on PATH" >&2
        exit 1
    fi
done

REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
REPO_PARENT=$(dirname "$REPO_ROOT")

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

# --- collect eligible issues -------------------------------------------------
# Mirror BogStandard's eligibility: chainlink ready (no open blockers) AND
# no open subissues. chainlink ready only checks blockers, so we verify
# subissues ourselves via chainlink show --json for each candidate.

ISSUES=""
COUNT=0
while IFS= read -r cand_id; do
    [[ -z "$cand_id" ]] && continue
    [[ $COUNT -ge $N ]] && break
    OPEN_SUBS=$(chainlink show --json "$cand_id" 2>/dev/null \
        | jq '([.subissues // [] | .[] | select(.status == "open")] | length)' 2>/dev/null \
        || echo "0")
    if [[ "$OPEN_SUBS" == "0" ]]; then
        ISSUES+="${cand_id}"$'\n'
        COUNT=$((COUNT + 1))
    fi
done < <(chainlink ready --json 2>/dev/null | jq -r '.[].id' 2>/dev/null || true)

ISSUES=$(printf '%s' "$ISSUES" | grep -v '^$')

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

    echo "Worker $i: issue #${issue_id} → ${WORKTREE} (${BRANCH})"

    # Create worktree + branch off main
    git worktree add -b "$BRANCH" "$WORKTREE" main

    # Symlink .chainlink so the worker shares the issue database.
    # .chainlink is gitignored so it won't exist in the fresh worktree.
    if [[ -e "${REPO_ROOT}/.chainlink" ]]; then
        ln -s "${REPO_ROOT}/.chainlink" "${WORKTREE}/.chainlink"
        # Exclude .chainlink from git's view in this worktree so it doesn't
        # show up as untracked and dirty the working tree.
        WORKTREE_GIT_DIR=$(git -C "$WORKTREE" rev-parse --git-dir)
        mkdir -p "${WORKTREE_GIT_DIR}/info"
        echo ".chainlink" >> "${WORKTREE_GIT_DIR}/info/exclude"
    fi

    # Build the pi invocation
    CMD="pi -e '${EXT_PATH}' /bogstandard ${issue_id}"
    if [[ ${#PI_ARGS[@]} -gt 0 ]]; then
        CMD="${CMD} ${PI_ARGS[*]}"
    fi

    if [[ "$first" -eq 1 ]]; then
        # Reuse the window created by new-session
        tmux rename-window -t "${SESSION}:0" "$WIN_NAME"
        tmux send-keys -t "${SESSION}:0" "cd '${WORKTREE}' && ${CMD}" Enter
        first=0
    else
        # New window, start directory set to worktree
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
