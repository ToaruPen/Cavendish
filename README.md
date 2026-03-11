# Cavendish

Playwright-based CLI tool that automates ChatGPT's Web UI, enabling coding agents (Claude Code, Codex CLI, etc.) to query ChatGPT Pro models via a single shell command.

## Tech Stack

- **Runtime**: Node.js
- **Browser Automation**: Playwright (headed mode, dedicated Chrome profile)
- **Language**: TypeScript
- **CLI Framework**: citty (UnJS)
- **Build Tool**: tsup

## Prerequisites

- **Node.js** >= 20
- **Google Chrome** (stable channel)
- **OS**: macOS, Linux, or Windows

## Installation

```bash
npm install -g cavendish
```

## Initial Setup

Cavendish uses a **dedicated Chrome profile** stored in `~/.cavendish/chrome-profile`. Your regular Chrome profile is not affected.

1. Run `cavendish init` — Chrome launches automatically with a new profile
2. ChatGPT opens in the new Chrome window — **log in to your ChatGPT account**
3. Done. The login session persists across CLI invocations (no re-login needed)

Verify the setup:

```bash
cavendish status        # Health diagnostics (alias for doctor)
cavendish doctor        # Health diagnostics (same checks as status)
```

> **Note**: The dedicated Chrome profile avoids conflicts with your browser extensions and protects your main profile from corruption. Chrome stays running as a background process between commands for fast reconnection via CDP (OS-assigned random port).

## Commands

### Init & Diagnostics

```bash
# Initial setup (launches Chrome, creates profile, waits for login)
cavendish init

# Reset profile and re-authenticate
cavendish init --reset

# Run health diagnostics (CDP, auth, selectors, integrations)
cavendish doctor
cavendish doctor --json

# Same diagnostics as doctor (status delegates to the same logic)
cavendish status
```

### Ask (core feature)

```bash
# Basic query
cavendish ask "Your question here"

# Specify model
cavendish ask --model pro "Your question here"

# Attach local files
cavendish ask --file ./src/main.ts "Review this code"

# Pipe from stdin
cat error.log | cavendish ask "Analyze this error"

# Use within a project
cavendish ask --project "For-Agents" "Describe the project policy"

# Continue the most recent chat
cavendish ask --continue "Explain further"

# Continue a specific chat by ID
cavendish ask --continue --chat <chat-id> "Follow up"

# Attach Google Drive files
cavendish ask --gdrive "document.pdf" "Analyze this"

# Attach GitHub repos as context
cavendish ask --github "owner/repo" "Review this codebase"

# Enable agent mode (code execution, file operations)
cavendish ask --agent "Solve this problem"

# Set thinking effort level (Thinking/Pro models)
cavendish ask --model thinking --thinking-effort extended "Hard problem"

# Streaming output (NDJSON)
cavendish ask --stream "Your question here"

# JSON output with metadata (chatId, url, model, timeoutSec)
# Note: model is omitted in JSON output when using --continue (intentional)
cavendish ask --format json "Your question here"

# Dry run (validate args without executing)
cavendish ask --dry-run "Your question here"
```

### Deep Research

```bash
# Start a deep research query
cavendish deep-research "Research topic"

# Attach files to the query
cavendish deep-research --file ./data.csv "Analyze this dataset"

# Follow up on an existing DR session
cavendish deep-research --chat <chat-id> "Follow up question"

# Re-run the same prompt on an existing DR session
cavendish deep-research --chat <chat-id> --refresh

# Export report to file (markdown, word, or pdf)
cavendish deep-research --export markdown "Research topic"
cavendish deep-research --export pdf --exportPath ./report.pdf "Research topic"

# Streaming output
cavendish deep-research --stream "Research topic"
```

### Chat Management

```bash
# List chats
cavendish list

# Read a chat
cavendish read <chat-id>

# Delete a chat
cavendish delete <chat-id>

# Delete a project chat
cavendish delete <chat-id> --project "Project Name"

# Archive a chat
cavendish archive <chat-id>

# Move a chat to a project
cavendish move <chat-id> --project "Project Name"
```

### Projects

```bash
# List projects
cavendish projects

# List chats in a project
cavendish projects --name "For-Agents" --chats

# Create a new project
cavendish projects --create --name "New Project"
```

### Global Options (all commands)

```bash
--quiet                  # Suppress progress output
--dry-run                # Validate args without executing
```

> **Note**: citty accepts both kebab-case (`--dry-run`) and camelCase (`--dryRun`) for multi-word flags. Both forms are equivalent. The `--help` output displays the camelCase form (e.g. `--dryRun`, `--thinkingEffort`, `--exportPath`) due to citty's internal convention.

### Options for ask / deep-research

```bash
--format text|json       # Output format (default: json)
--stream                 # NDJSON streaming output
--timeout 120            # Timeout in seconds (default: 120, Pro: 2400, DR: 1800)
```

> `--format` is also accepted by `list`, `read`, `projects`, and `status`. `doctor` uses its own `--json` flag.

## Architecture

```text
CLI (citty)
  -> ProcessLock (exclusive access via ~/.cavendish/cavendish.lock)
  -> BrowserManager (Chrome launch/connect via CDP, dynamic port)
    -> ChatGPTDriver (DOM operations)
      -> OutputHandler (text/json/ndjson to stdout)
      -> CavendishError (structured error classification)
  -> Shutdown (signal handlers, cleanup callbacks)
```

Key modules:

- **BrowserManager** — Chrome launch/connect/profile management (CDP with OS-assigned port, persistent process, orphan recovery)
- **ChatGPTDriver** — DOM operations (message send, response capture, file attach, model select, deep research)
- **OutputHandler** — Response formatting (text/json/ndjson to stdout, structured errors to stderr)
- **ProcessLock** — Atomic file-based lock (`~/.cavendish/cavendish.lock`) preventing parallel execution; stale lock recovery via PID check
- **Shutdown** — Signal handler registration (SIGINT/SIGTERM) with cleanup callbacks, lock release, and 3-second timeout
- **DoctorChecks** — System health diagnostics (CDP, auth, selectors, integrations)
- **CavendishError** — Structured error types with categories and exit codes

## Development

```bash
npm install          # Install dependencies
npm run build        # Build (tsup -> dist/index.mjs)
npm run dev          # Watch mode
npm run typecheck    # Type check (tsc --noEmit)
npm run lint         # Lint (ESLint)
npm test             # Run tests (vitest)
```

## Project Structure

```
cavendish/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point (citty)
│   ├── commands/
│   │   ├── ask.ts            # ask command
│   │   ├── deep-research.ts  # deep-research command
│   │   ├── init.ts           # init command
│   │   ├── doctor.ts         # doctor command
│   │   ├── status.ts         # status command
│   │   ├── list.ts           # list command
│   │   ├── read.ts           # read command
│   │   ├── delete.ts         # delete command
│   │   ├── archive.ts        # archive command
│   │   ├── move.ts           # move command
│   │   └── projects.ts       # projects command
│   ├── core/
│   │   ├── browser-manager.ts  # Chrome process management (CDP, dynamic port, orphan recovery)
│   │   ├── chatgpt-driver.ts   # DOM operations (facade)
│   │   ├── driver/             # ChatGPTDriver sub-modules
│   │   │   ├── attachments.ts  # Google Drive/GitHub/file attach
│   │   │   ├── deep-research.ts # Deep Research operations
│   │   │   ├── helpers.ts      # Shared helpers (delay, isTimeoutError)
│   │   │   └── response-handler.ts # Response detection and streaming
│   │   ├── chatgpt-types.ts    # Type definitions for ChatGPTDriver
│   │   ├── model-config.ts     # Model classification and thinking effort
│   │   ├── output-handler.ts   # Response formatting
│   │   ├── process-lock.ts     # Atomic file-based process lock
│   │   ├── shutdown.ts         # Signal handlers and cleanup callbacks
│   │   ├── cli-args.ts         # Shared CLI argument definitions
│   │   ├── doctor.ts           # Health check logic
│   │   ├── errors.ts           # Structured error types
│   │   └── with-driver.ts      # Driver lifecycle utility
│   └── constants/
│       └── selectors.ts        # DOM selector definitions
├── tests/
│   ├── ask-chat-options.test.ts
│   ├── ask-file.test.ts
│   ├── ask-stdin.test.ts
│   ├── cdp-robustness.test.ts
│   ├── chat-id.test.ts
│   ├── cleanup-registration.test.ts
│   ├── doctor.test.ts
│   ├── dr-report-poll.test.ts
│   ├── dr-timeout.test.ts
│   ├── errors.test.ts
│   ├── model-config.test.ts
│   ├── output-handler.test.ts
│   ├── process-lock.test.ts
│   ├── profile-directories.test.ts
│   ├── projects-validation.test.ts
│   ├── signal-handling.test.ts
│   └── wait-for-cdp.test.ts
└── docs/
    ├── plan.md
    └── live-test.md
```

## Security

Cavendish is designed for **single-user, local-machine use**. The security model assumes you are the only user on the machine.

### CDP Binding

Chrome is launched with `--remote-debugging-port=0`, which lets the OS assign a **random available port** instead of the well-known port 9222. The assigned port is discovered via Chrome's `DevToolsActivePort` file and saved to `~/.cavendish/cdp-endpoint.json` (0o600 permissions). The CDP endpoint is explicitly bound to **127.0.0.1 only** (`--remote-debugging-address=127.0.0.1`). This means:

- The CDP port is **unpredictable** — no well-known port for attackers to target.
- Only processes on the local machine can connect to the CDP endpoint.
- The port is **not** exposed to the network — remote hosts cannot reach it.
- The endpoint file (`cdp-endpoint.json`) is written with **0o600 permissions** and explicitly `chmod`-ed to enforce owner-only readability on macOS and Linux. On Windows, Node.js silently ignores POSIX permission bits beyond the read-only flag, so the file inherits NTFS ACLs from the user's home directory instead (same behavior as the Chrome profile directory).

### Chrome Profile Directory

The Chrome profile (`~/.cavendish/chrome-profile`) contains your ChatGPT session cookies. It is created and maintained with **0o700 permissions** (owner-only read/write/execute) on macOS and Linux, so other users on the same machine cannot read it. On Windows, `chmod` only affects the read-only flag, so the directory inherits NTFS ACLs from the user's home directory instead.

### Clipboard Permissions

Cavendish grants `clipboard-read` and `clipboard-write` permissions to `chatgpt.com` via the Playwright browser context. This is required for the Deep Research "copy content" feature, which reads the report from the system clipboard after clicking the export button inside an iframe.

### Process Lock

Cavendish uses an **atomic file-based lock** (`~/.cavendish/cavendish.lock`) to prevent parallel execution. Only one Cavendish command can interact with the Chrome instance at a time. The lock contains the owning process's PID and is automatically released on exit or signal (SIGINT/SIGTERM). Stale locks from crashed processes are detected and reclaimed.

### Multi-user Environments

If you run Cavendish on a shared machine:

- **macOS/Linux**: Verify that `~/.cavendish/` has `drwx------` permissions (`ls -ld ~/.cavendish`).
- **Windows**: Verify that `%USERPROFILE%\.cavendish\` inherits appropriate NTFS ACLs restricting access to your user account.
- The CDP port is OS-assigned and unpredictable, but binding to `127.0.0.1` does not isolate the endpoint from other users on the same machine. Verify that `cdp-endpoint.json` inside your Cavendish config directory (`~/.cavendish/` on macOS/Linux, `%USERPROFILE%\.cavendish\` on Windows) is not world-readable.
- Do **not** share your `~/.cavendish/chrome-profile` directory — it contains active session data.

## License

ISC
