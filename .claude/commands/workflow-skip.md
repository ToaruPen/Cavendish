Bypass the Development Cycle workflow gate. Use when the user explicitly wants to skip remaining steps (e.g., quick fix, hotfix).

Ask the user for a reason if one was not provided as an argument: $ARGUMENTS

Then set the skip_reason in the workflow state:

```bash
jq --arg reason "<USER_REASON>" '.skip_reason = $reason' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state
```

Replace `<USER_REASON>` with the actual reason provided by the user.

Confirm to the user that the workflow gate is now bypassed. Commits and pushes will be allowed.
