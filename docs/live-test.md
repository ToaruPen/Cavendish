# Live Chrome Test Guide

How to run end-to-end tests against real ChatGPT.

## Prerequisites

- System Chrome installed (`/Applications/Google Chrome.app` on macOS)
- ChatGPT account logged in (session persists in `~/.cavendish/chrome-profile`)
- `npm run build` completed

## Steps

### 1. Launch Chrome with Remote Debugging

```bash
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir=$HOME/.cavendish/chrome-profile \
  --disable-blink-features=AutomationControlled \
  --no-first-run \
  "https://chatgpt.com" > /dev/null 2>&1 &
```

### 2. Verify CDP Connection

```bash
curl -s http://127.0.0.1:9222/json/version | head -3
```

Expected: JSON with `Browser` and `webSocketDebuggerUrl` fields.

### 3. First-time Only: Log in to ChatGPT

Open the Chrome window, log in to ChatGPT manually. The session is saved to `~/.cavendish/chrome-profile` and persists across restarts.

### 4. Run cavendish Commands

```bash
# Basic
node dist/index.mjs ask "Hello" --format text --timeout 120

# With stdin
echo "context" | node dist/index.mjs ask "summarize" --format text --timeout 120

# With file attachment
node dist/index.mjs ask --file ./src/index.ts "review this" --format text --timeout 120

# With thinking effort
node dist/index.mjs ask "explain X" --model Pro --thinking-effort standard --format text --timeout 120
```

cavendish connects via CDP automatically — no need to relaunch Chrome between runs.

## Notes

- **Timeout**: Pro model needs 60–120s+. Default is 2400s for Pro.
- **Session expiry**: Re-login only when ChatGPT's session expires (rare with persistent profile).
- **Port conflict**: If port 9222 is in use, kill the old process first: `lsof -ti :9222 | xargs kill`.
- **Cleanup**: Chrome stays running after cavendish exits (by design). Kill manually when done.
