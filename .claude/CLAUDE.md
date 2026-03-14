# Cavendish

Playwright-based CLI that automates ChatGPT's Web UI for coding agents.

## Language Policy

- Responses to the user: Japanese
- LLM-facing documents (CLAUDE.md, AGENTS.md, code comments, commit messages, etc.): English
- GitHub issues: Japanese (human-reviewed)

## Commands

```bash
npm run build       # Build (tsup → dist/index.mjs)
npm run dev         # Watch mode
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint — MUST pass with zero errors before committing
npm run lint:fix    # ESLint with auto-fix
npm test            # Run tests (vitest)
npm run test:watch  # Watch mode
```

## Key Constraints

- All ChatGPT DOM selectors MUST live in `src/constants/selectors.ts` — never inline selectors
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- Every function MUST have an explicit return type (`explicit-function-return-type` is enforced)
- Imports: grouped by builtin → external → internal → relative, alphabetized within groups
- Chrome process is persistent (CDP connect, never launch per invocation) — see @docs/plan.md §5.1
- Config & Chrome profile stored in `~/.cavendish/`

## Error Handling

- Fail fast with actionable messages — no empty `catch {}` blocks
- Retry: max 3 attempts with logging
- Error categories and user guidance: see @docs/plan.md §7

## Testing

- **Real-world testing first**: verify against live ChatGPT before anything else
- Unit tests (vitest): DOM-independent logic only. `npm test` / `npm run test:watch`
- Do NOT create fixture-based mock tests (mock DOM diverges from production too quickly)
- Selector validation is done as health checks against live ChatGPT (e.g. `status` command)
- Bug fixes require a failing test before and passing test after
- Never delete or disable existing tests

### Live Chrome Test (mandatory per feature)

Every feature addition MUST include a live test against real Chrome + ChatGPT (`npm run build` first). Test the new/changed functionality end-to-end and confirm it works before marking the verify step complete. See @docs/live-test.md for setup steps.

## Agent Behavior

- **Sub-agents**: Aggressively use sub-agents for exploration — codebase search, doc lookup, web research, dependency investigation. Spawn them in parallel whenever multiple lookups are needed. Do not read files one-by-one when a sub-agent can search broadly.
- **LSP diagnostics**: Check diagnostics after edits. Fix type errors and lint warnings immediately — do not defer to a later `tsc` or `eslint` run.
- **Context7 MCP**: Use for fetching up-to-date library docs (Playwright, citty, etc.) instead of relying on training data.

## Development Cycle

Every feature/fix follows this sequence:

1. **Pull main** — `git pull origin main` to sync
2. **Create worktree** — isolate work from main
3. **Activate workflow gate** — run `/workflow-start` to enable commit/push gating
4. **Implement** — follow the issue scope, no drive-by fixes
5. **Verify (live test first)** — ALWAYS run live tests before reasoning about correctness
   - DOM-dependent code (ChatGPTDriver, BrowserManager): run the **Live Chrome Test** checklist (see Testing section)
   - DOM-independent code (OutputHandler, ConfigManager, utils): write and run vitest unit tests
   - When responding to review comments: verify with live test BEFORE deciding to fix or skip
   - **After live tests: delete all test conversations** created during verification via `cavendish delete <id>`
   - Mark complete after verification:
   ```bash
   jq '.steps.live_test_done = true' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state
   ```
6. **Simplify** — run `/simplify` to clean up code, then mark complete:
   ```bash
   jq '.steps.simplify_done = true' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state
   ```
7. **Quality gate** — `npm run lint && npm run typecheck && npm test` — all must pass
   (auto-tracked by PostToolUse hook when all three pass in a single command)
8. **Codex review** — run `/codex-review`, fix issues until approved, then mark complete:
   ```bash
   jq '.steps.codex_review_done = true' .claude/.workflow-state > tmp && mv tmp .claude/.workflow-state
   ```
9. **Ship** — commit → push → PR creation

Do NOT skip steps or reorder. Codex review happens after lint/typecheck/test pass.

**Workflow gate**: Steps 5-8 are enforced by a PreToolUse hook that blocks `git commit`/`git push` when `.claude/.workflow-state` exists and steps are incomplete. Use `/workflow-skip` to bypass with a reason. If `.workflow-state` does not exist, commits pass through freely (quick fix mode).

## References

- Architecture & module design: @docs/plan.md
- Live Chrome test setup: @docs/live-test.md
- Review checklist: @.github/copilot-instructions.md
