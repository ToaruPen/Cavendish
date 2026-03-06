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

1. Run any command (e.g. `cavendish ask "hello"`) — Chrome launches automatically
2. ChatGPT opens in the new Chrome window — **log in to your ChatGPT account**
3. Done. The login session persists across CLI invocations (no re-login needed)

> **Note**: The dedicated Chrome profile avoids conflicts with your browser extensions and protects your main profile from corruption. Chrome stays running as a background process between commands for fast reconnection via CDP (port 9222).

## Commands

### Ask (core feature)

```bash
# Basic query
cavendish ask "Your question here"

# Specify model
cavendish ask --model pro "Your question here"

# Attach files
cavendish ask --file ./src/main.ts "Review this code"

# Pipe from stdin
cat error.log | cavendish ask "Analyze this error"

# Use within a project
cavendish ask --project "For-Agents" "Describe the project policy"

# Continue an existing chat
cavendish ask --continue "Explain further"
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

### Common Options

```bash
--format text|json|markdown  # Output format (default: text)
--timeout 120                # Timeout in seconds (default: 120)
--quiet                      # Suppress progress output
```

## Architecture

```
CLI (citty)
  → BrowserManager (Chrome launch/connect via CDP)
    → ChatGPTDriver (DOM operations)
      → OutputHandler (response formatting to stdout)
```

Key modules:

- **BrowserManager** — Chrome launch/connect/profile management (CDP, persistent process)
- **ChatGPTDriver** — DOM operations (message send, response capture, file attach, model select)
- **OutputHandler** — Response formatting (text/json/markdown to stdout)
- **ConfigManager** — Config & Chrome profile storage (`~/.cavendish/`)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Type check
npm run typecheck
```

## Project Structure

```
cavendish/
├── package.json
├── tsconfig.json
├── src/
│   ├── commands/       # CLI command definitions
│   ├── core/           # Core modules (BrowserManager, ChatGPTDriver, etc.)
│   ├── constants/      # Selector definitions, config defaults
│   └── utils/          # Logger, retry utilities
├── tests/
└── docs/
    └── plan.md         # Project plan document
```

## License

ISC
