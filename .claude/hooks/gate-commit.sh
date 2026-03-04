#!/usr/bin/env bash
# PreToolUse hook: block git commit/push unless workflow steps are complete.
# Only active when .claude/.workflow-state exists (opt-in).

set -euo pipefail

WORKFLOW_STATE="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/.workflow-state"

# Read tool input from stdin (JSON with tool_name and tool_input)
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only gate actual git commit/push commands (not echo, grep, etc.)
# Match: git commit, git push, git -c ... commit, git -C ... push, etc.
if ! echo "$COMMAND" | grep -qE '(^|[;&|] *)git\b.*\b(commit|push)\b'; then
  exit 0
fi

# If no workflow state file, allow (quick fix mode)
if [ ! -f "$WORKFLOW_STATE" ]; then
  exit 0
fi

# If skip_reason is set, allow
SKIP_REASON=$(jq -r '.skip_reason // empty' "$WORKFLOW_STATE")
if [ -n "$SKIP_REASON" ]; then
  exit 0
fi

# Check each step
SIMPLIFY=$(jq -r '.steps.simplify_done' "$WORKFLOW_STATE")
QUALITY=$(jq -r '.steps.quality_gate_done' "$WORKFLOW_STATE")
CODEX=$(jq -r '.steps.codex_review_done' "$WORKFLOW_STATE")

MISSING=()
if [ "$SIMPLIFY" != "true" ]; then
  MISSING+=("simplify (run /simplify, then: jq '.steps.simplify_done = true' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state)")
fi
if [ "$QUALITY" != "true" ]; then
  MISSING+=("quality gate (run: npm run lint && npm run typecheck && npm test)")
fi
if [ "$CODEX" != "true" ]; then
  MISSING+=("codex review (run /codex-review, then: jq '.steps.codex_review_done = true' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state)")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "BLOCKED: Development Cycle steps incomplete."
  echo ""
  echo "Missing steps:"
  for step in "${MISSING[@]}"; do
    echo "  - $step"
  done
  echo ""
  echo "To bypass: run /workflow-skip with a reason."
  exit 2
fi

exit 0
