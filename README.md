# Cavendish

Playwright-based CLI tool that automates ChatGPT's Web UI, enabling coding agents (Claude Code, Codex CLI, etc.) to query ChatGPT Pro models via a single shell command.

## Tech Stack

- **Runtime**: Node.js
- **Browser Automation**: Playwright (headed mode, dedicated Chrome profile)
- **Language**: TypeScript
- **CLI Framework**: citty (UnJS)
- **Build Tool**: tsup

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
cavendish status        # Quick health check
cavendish doctor        # Full diagnostic report
```

> **Note**: The dedicated Chrome profile avoids conflicts with your browser extensions and protects your main profile from corruption. Chrome stays running as a background process between commands for fast reconnection via CDP (port 9222).

## Commands

### Init & Diagnostics

```bash
# Initial setup (launches Chrome, creates profile, waits for login)
cavendish init

# Reset profile and re-authenticate
cavendish init --reset

# Check system health (full diagnostics)
cavendish doctor
cavendish doctor --json

# Quick health check
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
  -> BrowserManager (Chrome launch/connect via CDP)
    -> ChatGPTDriver (DOM operations)
      -> OutputHandler (text/json/ndjson to stdout)
      -> CavendishError (structured error classification)
```

Key modules:

- **BrowserManager** — Chrome launch/connect/profile management (CDP, persistent process)
- **ChatGPTDriver** — DOM operations (message send, response capture, file attach, model select, deep research)
- **OutputHandler** — Response formatting (text/json/ndjson to stdout, structured errors to stderr)
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
│   │   ├── browser-manager.ts  # Chrome process management
│   │   ├── chatgpt-driver.ts   # DOM operations
│   │   ├── output-handler.ts   # Response formatting
│   │   ├── cli-args.ts         # Shared CLI argument definitions
│   │   ├── doctor.ts           # Health check logic
│   │   ├── errors.ts           # Structured error types
│   │   └── with-driver.ts      # Driver lifecycle utility
│   └── constants/
│       └── selectors.ts        # DOM selector definitions
├── tests/
│   ├── errors.test.ts
│   ├── output-handler.test.ts
│   ├── ask-file.test.ts
│   ├── ask-stdin.test.ts
│   └── ask-chat-options.test.ts
└── docs/
    ├── plan.md
    └── live-test.md
```

## License

ISC
