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

## Chrome Profile & Session Management

### How sessions work

Cavendish uses a dedicated Chrome profile at `~/.cavendish/chrome-profile`. Once you log in to ChatGPT, the session (cookies, local storage) is saved to this directory and persists across restarts — **you should only need to log in once.**

### Important: always quit Chrome gracefully

Chrome writes session data to disk on **graceful shutdown only**. If Chrome is force-killed (`pkill`, `kill -9`, crash), the session may not be saved and you will need to log in again.

```bash
# ✅ Correct — session is saved
osascript -e 'tell application "Google Chrome" to quit'

# ❌ Wrong — session may be lost
pkill -f "Google Chrome"
kill -9 <pid>
```

### Why `--user-data-dir` is required

Chrome's remote debugging (`--remote-debugging-port`) **only works with a non-default data directory**. Using your regular Chrome profile without `--user-data-dir` will silently ignore the debugging port — CDP will not be available and cavendish cannot connect.

The cavendish profile at `~/.cavendish/chrome-profile` is separate from your regular Chrome profile. This means:
- Your regular Chrome bookmarks, extensions, and history are not affected
- You need to log in to ChatGPT once in the cavendish profile
- The cavendish profile is lightweight (only ChatGPT session data)

### Troubleshooting login issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Must log in every time | Chrome was force-killed | Always use `osascript` to quit |
| CDP not connecting | Default profile used (no `--user-data-dir`) | Use `~/.cavendish/chrome-profile` |
| "Browser window not found" on launch | Another Chrome instance is running | Quit all Chrome instances first |
| Session expired after long idle | ChatGPT's own session timeout | Re-login (normal, infrequent) |

## Notes

- **Timeout**: Pro model responses can take 5–20+ minutes. Default is unlimited (no `--timeout`). Specify `--timeout <sec>` explicitly if needed.
- **Port conflict**: If port 9222 is in use, kill the old process first: `lsof -ti :9222 | xargs kill`.
- **Cleanup**: Chrome stays running after cavendish exits (by design). Quit gracefully when done.
