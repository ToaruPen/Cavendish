import { existsSync, rmSync } from 'node:fs';

import { defineCommand } from 'citty';

import { CHATGPT_BASE_URL, SELECTORS } from '../constants/selectors.js';
import { BrowserManager, CDP_BASE_URL, CHROME_PROFILE_DIR } from '../core/browser-manager.js';
import { FORMAT_ARG, GLOBAL_ARGS } from '../core/cli-args.js';
import { errorMessage, fail, jsonRaw, progress, text, validateFormat } from '../core/output-handler.js';

/** Polling interval (ms) while waiting for user to log in. */
const LOGIN_POLL_INTERVAL_MS = 3_000;

/** Maximum time (ms) to wait for the user to log in before giving up. */
const LOGIN_TIMEOUT_MS = 300_000; // 5 minutes

interface InitResult {
  status: 'ready';
  profile: string;
  cdp: boolean;
  loggedIn: boolean;
}

/**
 * Check whether a ChatGPT tab appears logged in by querying CDP /json/list.
 * Returns true if at least one non-auth ChatGPT page is found.
 */
async function isLoggedInViaCdp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_BASE_URL}/json/list`);
    if (!res.ok) {
      return false;
    }
    const pages = (await res.json()) as { url: string }[];
    const chatgptPages = pages.filter((p) => p.url.startsWith(CHATGPT_BASE_URL));
    const nonAuthPages = chatgptPages.filter(
      (p) =>
        !p.url.includes('/auth/') &&
        !p.url.includes('/share/') &&
        !p.url.includes('/login') &&
        // Bare landing page (logged-out homepage) is not a reliable auth signal
        new URL(p.url).pathname !== '/',
    );
    return nonAuthPages.length > 0;
  } catch (error: unknown) {
    // CDP query failed — Chrome not running or not reachable; log and return false
    console.error(`[cavendish] CDP probe failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Wait for the prompt textarea to become visible on the page,
 * indicating that the user has logged in to ChatGPT.
 * Falls back to CDP tab-URL heuristic when Playwright detection fails.
 */
async function waitForLogin(
  browser: BrowserManager,
  quiet: boolean,
): Promise<boolean> {
  progress('Waiting for ChatGPT login (open the browser and log in)...', quiet);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const page = await browser.getPage(true);
      const promptInput = page.locator(SELECTORS.PROMPT_INPUT);
      await promptInput.waitFor({ state: 'visible', timeout: 5_000 });
      return true;
    } catch {
      // Prompt not visible yet — may be on login page or still loading.
      // Fall back to CDP heuristic (non-auth tab means logged in).
      if (await isLoggedInViaCdp()) {
        return true;
      }
    }

    await new Promise((r) => setTimeout(r, LOGIN_POLL_INTERVAL_MS));
  }

  return false;
}

/**
 * Close any Chrome process listening on the CDP port via the DevTools
 * protocol `Browser.close` command.  This terminates the Chrome process
 * cleanly without relying on platform-specific shell commands.
 *
 * Needed after profile reset so that the stale Chrome process (still
 * using the old profile in memory) is terminated before re-launch.
 */
async function killExistingChrome(quiet: boolean): Promise<void> {
  let wsUrl: string;
  try {
    const res = await fetch(`${CDP_BASE_URL}/json/version`);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) {
      return;
    }
    wsUrl = data.webSocketDebuggerUrl;
  } catch {
    // Chrome is not running — nothing to kill
    return;
  }

  progress('Stopping existing Chrome process...', quiet);
  try {
    // Send Browser.close via the CDP WebSocket to terminate Chrome
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for Browser.close'));
      }, 5_000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      });
      ws.addEventListener('message', () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.addEventListener('error', () => {
        // Connection error likely means Chrome already closed
        clearTimeout(timer);
        resolve();
      });
    });
    // Give Chrome a moment to fully shut down
    await new Promise((r) => setTimeout(r, 1_000));
    progress('Chrome process stopped', quiet);
  } catch {
    progress('Could not stop Chrome automatically. Please close Chrome manually and retry.', quiet);
  }
}

/**
 * Handle --reset flag: delete existing Chrome profile if it exists.
 */
function handleProfileReset(quiet: boolean): void {
  if (existsSync(CHROME_PROFILE_DIR)) {
    progress(`Removing existing profile: ${CHROME_PROFILE_DIR}`, quiet);
    rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
    progress('Profile removed', quiet);
  } else {
    progress('No existing profile to remove', quiet);
  }
}

/**
 * Log current profile directory status.
 */
function reportProfileStatus(quiet: boolean): void {
  if (existsSync(CHROME_PROFILE_DIR)) {
    progress(`Profile directory exists: ${CHROME_PROFILE_DIR}`, quiet);
  } else {
    progress(`Profile directory will be created on Chrome launch: ${CHROME_PROFILE_DIR}`, quiet);
  }
}

/**
 * Connect to Chrome, verify login, and return the init result.
 */
async function setupAndVerify(quiet: boolean): Promise<InitResult> {
  const browser = new BrowserManager();

  try {
    progress('Connecting to Chrome...', quiet);
    await browser.getPage(quiet);
    progress('Chrome is ready', quiet);

    const loggedIn = await waitForLogin(browser, quiet);

    if (loggedIn) {
      progress('ChatGPT login confirmed', quiet);
    } else {
      progress('Login not detected within timeout. Run "cavendish init" again after logging in.', quiet);
    }

    return {
      status: 'ready',
      profile: CHROME_PROFILE_DIR,
      cdp: true,
      loggedIn,
    };
  } finally {
    await browser.close();
  }
}

function formatTextOutput(result: InitResult): string[] {
  return [
    `Status:    ${result.status}`,
    `Profile:   ${result.profile}`,
    `CDP:       ${result.cdp ? 'connected' : 'not connected'}`,
    `Logged in: ${result.loggedIn ? 'yes' : 'no'}`,
  ];
}

function outputResult(result: InitResult, format: 'json' | 'text'): void {
  if (format === 'json') {
    jsonRaw(result);
  } else {
    for (const line of formatTextOutput(result)) {
      text(line);
    }
  }
}

/**
 * `cavendish init` — initialize Chrome profile and verify ChatGPT login.
 */
export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize Chrome profile and verify ChatGPT login',
  },
  args: {
    reset: {
      type: 'boolean',
      description: 'Delete and recreate the Chrome profile directory',
    },
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const format = validateFormat(args.format);
    if (format === undefined) {
      return;
    }

    if (args.dryRun === true) {
      const action = args.reset === true ? 'reset and reinitialize' : 'initialize';
      progress(`[dry-run] Would ${action} Chrome profile at ${CHROME_PROFILE_DIR}`, false);
      return;
    }

    if (args.reset === true) {
      await killExistingChrome(quiet);
      handleProfileReset(quiet);
    }

    reportProfileStatus(quiet);

    try {
      const result = await setupAndVerify(quiet);
      outputResult(result, format);

      if (!result.loggedIn) {
        process.exitCode = 1;
      }
    } catch (error: unknown) {
      fail(`Chrome setup failed: ${errorMessage(error)}. Ensure Chrome is installed and port 9222 is free.`);
    }
  },
});
