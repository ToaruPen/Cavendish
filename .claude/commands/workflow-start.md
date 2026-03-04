Initialize the Development Cycle workflow gate. Run this after creating a worktree (step 2).

Execute the following command to create the workflow state file:

```bash
cat > .claude/.workflow-state << 'EOF'
{"version":1,"started_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","steps":{"simplify_done":false,"quality_gate_done":false,"codex_review_done":false},"skip_reason":null}
EOF
```

Then fix the timestamp by running:

```bash
jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.started_at = $ts' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state
```

Confirm to the user that the workflow gate is now active. Commits and pushes will be blocked until:
1. `/simplify` is run (then manually mark `simplify_done`)
2. `npm run lint && npm run typecheck && npm test` passes (auto-tracked)
3. `/codex-review` is run (then manually mark `codex_review_done`)

The user can bypass with `/workflow-skip` if needed.
