# Copilot Custom Instructions

This project is **cavendish** — a Playwright-based CLI tool that automates ChatGPT's Web UI,
allowing coding agents (Claude Code, Codex CLI, etc.) to query ChatGPT Pro models via a single shell command.

## Tech Stack

- **Runtime**: Node.js
- **Browser automation**: Playwright (headed mode, dedicated Chrome profile)
- **Language**: TypeScript
- **CLI framework**: commander

## Architecture (key modules)

- `BrowserManager` — Chrome launch/connect/profile management (CDP, persistent process)
- `ChatGPTDriver` — DOM operations (message send, response capture, file attach, model select)
- `OutputHandler` — Response formatting (text/json/markdown to stdout)
- `ConfigManager` — Config & Chrome profile storage (`~/.cavendish/`)

## Review Focus Areas

### Selector Resilience

- All ChatGPT DOM selectors MUST be defined in `constants/selectors.ts`, never inline.
- Flag any hardcoded selector strings outside the constants file.
- Selectors break on ChatGPT UI updates — warn if a selector lacks a fallback or error message.

### Browser Lifecycle

- Chrome process is persistent (launched once, reused via CDP connect).
- Flag any code that launches a new Chrome instance per CLI invocation.
- Ensure proper cleanup: auto-shutdown timer, graceful close on errors.

### Error Handling

- Errors must fail fast with actionable messages (not silent failures).
- Required error categories per the plan:
  - Chrome launch failure → guide to `cavendish init`
  - Session expiry → guide to re-login
  - Cloudflare challenge → guide to manual resolution
  - Selector miss → log the specific selector for quick fix
  - Response timeout → return partial response with timeout info
- Empty catch blocks `catch(e) {}` are not acceptable.
- Retry logic should have a max of 3 attempts with clear logging.

### Type Safety

- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Playwright API types should be used explicitly (Page, BrowserContext, etc.).

### Testing

- Tests must have meaningful assertions, not just "no error thrown".
- Playwright interactions should be testable via dependency injection (driver pattern).
- Selectors should be tested against mock DOM where possible.

### Security

- No credentials or session tokens in code or logs.
- Chrome profile path (`~/.cavendish/chrome-profile/`) must not be committed.
- Warn about any `eval()` or dynamic code execution.

### Code Style

- Keep functions small and focused (single responsibility).
- Comments explain **why**, not **what**.
- Match existing patterns in the codebase.
- Prefer explicit error types over generic `Error`.
