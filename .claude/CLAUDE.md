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

## Agent Behavior

- **Sub-agents**: Aggressively use sub-agents for exploration — codebase search, doc lookup, web research, dependency investigation. Spawn them in parallel whenever multiple lookups are needed. Do not read files one-by-one when a sub-agent can search broadly.
- **LSP diagnostics**: Check diagnostics after edits. Fix type errors and lint warnings immediately — do not defer to a later `tsc` or `eslint` run.
- **Context7 MCP**: Use for fetching up-to-date library docs (Playwright, citty, etc.) instead of relying on training data.

## Development Cycle

Every feature/fix follows this sequence:

1. **Pull main** — `git pull origin main` to sync
2. **Create worktree** — isolate work from main
3. **Implement** — follow the issue scope, no drive-by fixes
4. **Verify**
   - DOM-dependent code (ChatGPTDriver, BrowserManager): live test against ChatGPT
   - DOM-independent code (OutputHandler, ConfigManager, utils): write and run vitest unit tests
5. **Simplify** — run `/simplify` to clean up code
6. **Quality gate** — `npm run lint && npm run typecheck && npm test` — all must pass
7. **Codex review** — run `/codex-review`, fix issues until approved
8. **Ship** — commit → push → PR creation

Do NOT skip steps or reorder. Codex review happens after lint/typecheck/test pass.

## References

- Architecture & module design: @docs/plan.md
- Review checklist: @.github/copilot-instructions.md
