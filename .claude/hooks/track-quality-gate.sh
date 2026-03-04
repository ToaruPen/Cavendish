#!/usr/bin/env bash
# PostToolUse hook: auto-mark quality_gate_done when lint+typecheck+test all pass.
# Only active when .claude/.workflow-state exists.

set -euo pipefail

WORKFLOW_STATE="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/.workflow-state"

# If no workflow state file, nothing to track
if [ ! -f "$WORKFLOW_STATE" ]; then
  exit 0
fi

# Read tool input from stdin (JSON with tool_input)
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Check if the command contains all three quality gate commands
if echo "$COMMAND" | grep -q "npm run lint" && \
   echo "$COMMAND" | grep -q "npm run typecheck" && \
   echo "$COMMAND" | grep -q "npm test"; then
  jq '.steps.quality_gate_done = true' "$WORKFLOW_STATE" > "${WORKFLOW_STATE}.tmp" && \
    mv "${WORKFLOW_STATE}.tmp" "$WORKFLOW_STATE"
fi

exit 0
