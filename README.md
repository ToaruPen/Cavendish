# Cavendish

[![npm version](https://img.shields.io/npm/v/cavendish)](https://www.npmjs.com/package/cavendish)
[![Node.js](https://img.shields.io/node/v/cavendish)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

**Playwright-based CLI that automates ChatGPT's Web UI** — enabling coding agents (Claude Code, Codex CLI, etc.) to query ChatGPT Pro models via a single shell command. Detach-first since v2.0.0.

```bash
# Ask ChatGPT (returns job ID — detached by default)
cavendish ask "Explain the Observer pattern with a TypeScript example"
# Retrieve the result
cavendish jobs wait <job-id>

# Synchronous mode (blocks until response)
cavendish ask --sync "Quick question"

# Deep Research with PDF export (synchronous)
cavendish deep-research --sync --export pdf "State of WebAssembly in 2026"
```

## Disclaimer

> **This tool automates ChatGPT's Web UI using browser automation and may violate [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/). Its availability does not guarantee compliance with those terms. Use at your own risk.**
>
> This tool requires a valid ChatGPT paid subscription (Pro, Plus, Team, or Enterprise) and does not bypass any payment or authentication. It exists primarily to provide programmatic access to features not yet available through OpenAI's official API, such as Deep Research. If OpenAI releases official API support for these features, we recommend migrating to the official API.

## Features

- **Multi-model support** — Pro, Thinking, and other ChatGPT models with configurable thinking effort
- **Deep Research** — long-running research with streaming progress and export (Markdown / Word / PDF)
- **File attachments** — local files, Google Drive, and GitHub repos as context
- **Project-aware** — ChatGPT Projects integration for organized workflows
- **Chat management** — list, read, continue, archive, move, and delete conversations (batch support for delete/archive/move)
- **Agent mode** — enable ChatGPT's code execution and file operations
- **Streaming output** — real-time NDJSON streaming for integration with other tools
- **Detached jobs** — submit long-running work and collect completion later via job state and notifications
- **Health diagnostics** — built-in `doctor` command to verify CDP, auth, and selectors
- **Selector drift detection** — `report` command validates all selectors against live DOM, tracks baseline changes, and auto-creates GitHub issues
- **Process safety** — exclusive lock prevents concurrent access; signal-safe cleanup
- **CLI robustness** — unknown flag detection, structured exit codes, cross-platform support (macOS / Linux / Windows)

## Prerequisites

- **Node.js** >= 20
- **Google Chrome** (stable channel)
- **ChatGPT Pro, Plus, Team, or Enterprise account** (required for Pro models and Deep Research)
- **OS**: macOS, Linux, or Windows

## Installation

```bash
npm install -g cavendish
```

Update to the latest version:

```bash
npm update -g cavendish
```

## Quick Start

Cavendish uses a **dedicated Chrome profile** stored in `~/.cavendish/chrome-profile`. Your regular Chrome profile is not affected.

1. Run `cavendish init` — Chrome launches automatically with a new profile
2. ChatGPT opens in the new Chrome window — **log in to your ChatGPT account**
3. Done. The login session persists across CLI invocations (no re-login needed)

Verify the setup:

```bash
cavendish doctor        # Health diagnostics (CDP, auth, selectors)
```

> **Note**: Chrome stays running as a background process between commands for fast reconnection via CDP (OS-assigned random port). The dedicated profile avoids conflicts with your browser extensions.

## Usage

### Ask (core command)

```bash
# Basic query (returns job ID — detached by default)
cavendish ask "Your question here"

# Wait for the result
cavendish jobs wait <job-id>

# Synchronous mode (blocks until response)
cavendish ask --sync "Your question here"

# Streaming output (implies --sync)
cavendish ask --stream "Your question here"

# Specify model
cavendish ask --sync --model pro "Your question here"

# Attach local files
cavendish ask --sync --file ./src/main.ts "Review this code"

# Pipe from stdin
cat error.log | cavendish ask --sync "Analyze this error"

# Use within a ChatGPT project
cavendish ask --sync --project "For-Agents" "Describe the project policy"

# Continue the most recent chat
cavendish ask --sync --continue "Explain further"

# Continue a specific chat by ID
cavendish ask --sync --continue --chat <chat-id> "Follow up"

# Attach Google Drive files
cavendish ask --sync --gdrive "document.pdf" "Analyze this"

# Attach GitHub repos as context
cavendish ask --sync --github "owner/repo" "Review this codebase"

# Enable agent mode (code execution, file operations)
cavendish ask --sync --agent "Solve this problem"

# Set thinking effort level (Thinking/Pro models)
cavendish ask --sync --model thinking --thinking-effort extended "Hard problem"

# JSON output with metadata (chatId, url, model, timeoutSec)
cavendish ask --sync --format json "Your question here"

# Dry run (validate args without executing)
cavendish ask --dry-run "Your question here"
```

### Deep Research

```bash
# Start a deep research query (returns job ID — detached by default)
cavendish deep-research "Research topic"

# Wait for the result
cavendish jobs wait <job-id>

# Synchronous mode (blocks until response)
cavendish deep-research --sync "Research topic"

# Attach files to the query
cavendish deep-research --sync --file ./data.csv "Analyze this dataset"

# Follow up on an existing DR session
cavendish deep-research --sync --chat <chat-id> "Follow up question"

# Re-run the same prompt on an existing DR session
cavendish deep-research --sync --chat <chat-id> --refresh

# Export report to file (markdown, word, or pdf)
cavendish deep-research --sync --export markdown "Research topic"
cavendish deep-research --sync --export pdf --exportPath ./report.pdf "Research topic"

# Streaming output (implies --sync)
cavendish deep-research --stream "Research topic"
```

### Detached Jobs

```bash
# List detached jobs
cavendish jobs list

# Inspect job status
cavendish jobs status <job-id>

# Wait for completion and print the final content
cavendish jobs wait <job-id>
```

### Chat Management

```bash
cavendish list                                    # List chats
cavendish read <chat-id>                          # Read a chat
cavendish delete <chat-id>                        # Delete a chat
cavendish delete id1 id2 id3                      # Batch delete
cavendish delete <chat-id> --project "Project"    # Delete a project chat
cavendish archive <chat-id>                       # Archive a chat
cavendish archive id1 id2 id3                     # Batch archive
cavendish move <chat-id> --project "Project"      # Move to a project
cavendish move id1 id2 --project "Project"        # Batch move

# Read IDs from stdin (pipe-friendly)
cavendish list --format json | jq -r '.[].id' | cavendish delete --stdin
```

### Projects

```bash
cavendish projects                                # List projects
cavendish projects --name "For-Agents" --chats    # List chats in a project
cavendish projects --create --name "New Project"  # Create a new project
```

### Init & Diagnostics

```bash
cavendish init                # Initial setup (launch Chrome, create profile)
cavendish init --reset        # Reset profile and re-authenticate
cavendish doctor              # Health diagnostics (CDP, auth, selectors)
cavendish doctor --json       # JSON output
cavendish status              # Alias for doctor
cavendish status --json       # JSON output (same as doctor --json)

# Selector drift detection
cavendish report                  # Validate all selectors against live ChatGPT DOM
cavendish report --save-baseline  # Save current DOM state as baseline
cavendish report --issue          # Auto-create GitHub issue if selectors are broken
cavendish report --format json    # JSON output (for CI/automation)
```

### Common Options

| Flag | Scope | Description |
|------|-------|-------------|
| `--format text\|json` | ask, deep-research, delete, init, jobs, list, read, projects, report | Output / error format (default: `json`; report default: `text`) |
| `--sync` | ask, deep-research | Run synchronously instead of detached (default: detached) |
| `--stream` | ask, deep-research | NDJSON streaming output (implies `--sync`) |
| `--detach` | ask, deep-research | Submit as detached background job (default behavior) |
| `--notify-file <path>` | ask, deep-research | Append a completion notification JSON line to a local file |
| `--timeout <sec>` | ask, deep-research, jobs wait | Timeout in seconds (default: unlimited) |
| `--upload-timeout <sec>` | ask, deep-research | Upload timeout for file attachments (default: 180) |
| `--stdin` | delete, archive, move | Read conversation IDs from stdin (one per line) |
| `--quiet` | all | Suppress progress output |
| `--dry-run` | all | Validate args without executing |

> **Note**: citty accepts both kebab-case (`--dry-run`) and camelCase (`--dryRun`). The `--help` output displays camelCase due to citty's internal convention.

## Architecture

```text
CLI (citty)
  -> ProcessLock (exclusive access via ~/.cavendish/cavendish.lock)
  -> JobStore (detached job metadata under ~/.cavendish/jobs)
  -> JobRunner (single detached queue owner for queued background jobs)
  -> BrowserManager (Chrome launch/connect via CDP, dynamic port)
    -> ChatGPTDriver (DOM operations)
      -> OutputHandler (text/json/ndjson to stdout)
      -> CavendishError (structured error classification)
  -> Shutdown (signal handlers, cleanup callbacks)
```

| Module | Responsibility |
|--------|---------------|
| **BrowserManager** | Chrome launch/connect/profile management (CDP with OS-assigned port, persistent process, orphan recovery) |
| **ChatGPTDriver** | DOM operations (message send, response capture, file attach, model select, deep research) |
| **JobRunner** | Sequential detached-job execution, queue ownership, and retry-on-lock handoff for background jobs |
| **OutputHandler** | Response formatting (text/json/ndjson to stdout, structured errors to stderr) |
| **ProcessLock** | Atomic file-based lock preventing parallel execution; stale lock recovery via PID check |
| **Shutdown** | Signal handler registration (SIGINT/SIGTERM) with cleanup callbacks, lock release, 3s timeout |
| **DoctorChecks** | System health diagnostics (CDP, auth, selectors, integrations) |
| **CavendishError** | Structured error types with categories and exit codes |

## Development

```bash
npm install          # Install dependencies
npm run build        # Build (tsup -> dist/index.mjs)
npm run dev          # Watch mode
npm run typecheck    # Type check (tsc --noEmit)
npm run lint         # Lint (ESLint)
npm test             # Run tests (vitest)
```

<details>
<summary>Project Structure</summary>

```text
src/
├── index.ts                    # Entry point (citty)
├── commands/
│   ├── ask.ts                  # ask command
│   ├── deep-research.ts        # deep-research command
│   ├── init.ts                 # init command
│   ├── doctor.ts               # doctor command
│   ├── status.ts               # status command
│   ├── jobs.ts                 # detached job commands
│   ├── list.ts                 # list command
│   ├── read.ts                 # read command
│   ├── delete.ts               # delete command
│   ├── archive.ts              # archive command
│   ├── move.ts                 # move command
│   └── projects.ts             # projects command
├── core/
│   ├── browser-manager.ts      # Chrome process management (CDP, dynamic port, orphan recovery)
│   ├── chatgpt-driver.ts       # DOM operations (facade)
│   ├── driver/
│   │   ├── attachments.ts      # Google Drive/GitHub/file attach
│   │   ├── deep-research.ts    # Deep Research operations
│   │   ├── helpers.ts          # Shared helpers (delay, isTimeoutError)
│   │   └── response-handler.ts # Response detection and streaming
│   ├── chatgpt-types.ts        # Type definitions for ChatGPTDriver
│   ├── model-config.ts         # Model classification and thinking effort
│   ├── output-handler.ts       # Response formatting
│   ├── process-lock.ts         # Atomic file-based process lock
│   ├── jobs/                   # Detached job store, worker, notifications
│   ├── shutdown.ts             # Signal handlers and cleanup callbacks
│   ├── cli-args.ts             # Shared CLI argument definitions
│   ├── doctor.ts               # Health check logic
│   ├── errors.ts               # Structured error types
│   └── with-driver.ts          # Driver lifecycle utility
└── constants/
    └── selectors.ts            # DOM selector definitions
```

</details>

## Exit Codes

Cavendish uses structured exit codes so calling agents can handle errors programmatically.

| Code | Category | Description | Suggested Action |
|------|----------|-------------|------------------|
| 0 | — | Success | — |
| 1 | `unknown` | Unclassified error | Check the error message for details |
| 2 | `cdp_unavailable` | Chrome CDP not reachable | Run `cavendish init` to start Chrome |
| 3 | `chrome_not_found` | Chrome binary not found | Install Google Chrome and ensure it is in your PATH |
| 4 | `auth_expired` | ChatGPT session expired | Open Chrome and log in to ChatGPT |
| 5 | `cloudflare_blocked` | Cloudflare challenge detected | Solve the challenge in the Chrome tab |
| 6 | `selector_miss` | DOM selector not found | ChatGPT UI may have changed; run `cavendish status` |
| 7 | `timeout` | Operation timed out | Increase `--timeout` or check ChatGPT in the browser |
| 8 | `chrome_launch_failed` | Chrome failed to launch | Check permissions; run `cavendish init` |
| 9 | `chrome_close_failed` | Chrome failed to close | Close Chrome manually |

With `--format json`, errors are written to stderr as structured JSON:

```json
{ "error": true, "category": "cdp_unavailable", "message": "...", "exitCode": 2, "action": "Run \"cavendish init\"..." }
```

## Security

Cavendish is designed for **single-user, local-machine use**. The security model assumes you are the only user on the machine.

### CDP Binding

Chrome is launched with `--remote-debugging-port=0`, which lets the OS assign a **random available port** instead of the well-known port 9222. The assigned port is discovered via Chrome's `DevToolsActivePort` file and saved to `~/.cavendish/cdp-endpoint.json`. The CDP endpoint is explicitly bound to **127.0.0.1 only** (`--remote-debugging-address=127.0.0.1`).

- The CDP port is **unpredictable** — no well-known port for attackers to target.
- Only processes on the local machine can connect to the CDP endpoint.
- The port is **not** exposed to the network — remote hosts cannot reach it.
- The endpoint file (`cdp-endpoint.json`) is written with **0o600 permissions** and explicitly `chmod`-ed to enforce owner-only readability on macOS and Linux. On Windows, Node.js silently ignores POSIX permission bits beyond the read-only flag, so the file inherits NTFS ACLs from the user's home directory instead (same behavior as the Chrome profile directory).

### Chrome Profile Directory

The Chrome profile (`~/.cavendish/chrome-profile`) contains your ChatGPT session cookies. It is created and maintained with **0o700 permissions** (owner-only read/write/execute) on macOS and Linux, so other users on the same machine cannot read it. On Windows, `chmod` only affects the read-only flag, so the directory inherits NTFS ACLs from the user's home directory instead.

### Process Lock

Cavendish uses an **atomic file-based lock** (`~/.cavendish/cavendish.lock`) to prevent parallel execution. Only one Cavendish command can interact with the Chrome instance at a time. The lock contains the owning process's PID and is automatically released on exit or signal (SIGINT/SIGTERM). Stale locks from crashed processes are detected and reclaimed.

### Clipboard Permissions

The `deep-research` command only requests `clipboard-read` and `clipboard-write` permissions for `chatgpt.com` when `--export` is specified, because the export workflow uses the system clipboard to retrieve clean report content. In the shared browser context, permissions granted by a prior export run may still persist.

<details>
<summary>Multi-user Environments</summary>

If you run Cavendish on a shared machine:

- **macOS/Linux**: Verify that `~/.cavendish/` has `drwx------` permissions (`ls -ld ~/.cavendish`).
- **Windows**: Verify that `%USERPROFILE%\.cavendish\` inherits appropriate NTFS ACLs restricting access to your user account.
- The CDP port is OS-assigned and unpredictable, but binding to `127.0.0.1` does not isolate the endpoint from other users on the same machine. Verify that `cdp-endpoint.json` inside your Cavendish config directory (`~/.cavendish/` on macOS/Linux, `%USERPROFILE%\.cavendish\` on Windows) is not world-readable.
- Do **not** share your `~/.cavendish/chrome-profile` directory — it contains active session data.

</details>

## Migrating from v1.x to v2.0

v2.0 changes the default execution model. All commands now run **detached** (background) by default.

### Breaking changes

| Before (v1.x) | After (v2.0) |
|----------------|--------------|
| `cavendish ask "..."` blocks and returns response | Returns job metadata (jobId) immediately |
| `--detach` opt-in for background execution | Default behavior |
| `--timeout` defaults: ask 120s, Pro 2400s, DR 1800s | Default: unlimited (no timeout) |
| `--stream` + `--detach` rejected | `--stream` implies `--sync` |

### Migration

```bash
# v1.x: direct response
cavendish ask "question"

# v2.0 equivalent: use --sync
cavendish ask --sync "question"

# v2.0 recommended: detach + wait
cavendish ask "question"                # returns jobId
cavendish jobs wait <job-id>            # returns response
```

If your agent integration pipes stdout directly, add `--sync` to preserve the v1.x behavior.

## License

ISC
