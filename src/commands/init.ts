import { existsSync, rmSync } from 'node:fs';

import { defineCommand } from 'citty';
import { type Page, errors } from 'playwright';

import { CHATGPT_BASE_URL, SELECTORS } from '../constants/selectors.js';
import { BrowserManager, CDP_BASE_URL, CHROME_PROFILE_DIR } from '../core/browser-manager.js';
import { FORMAT_ARG, GLOBAL_ARGS } from '../core/cli-args.js';
import { errorMessage, fail, jsonRaw, progress, text, validateFormat } from '../core/output-handler.js';

/** Polling interval (ms) while waiting for user to log in. */
const LOGIN_POLL_INTERVAL_MS = 3_000;

/** Maximum time (ms) to wait for the user to log in before giving up. */
const LOGIN_TIMEOUT_MS = 300_000; // 5 minutes

/** Timeout (ms) for detecting the login button on the ChatGPT landing page. */
const LOGIN_BUTTON_TIMEOUT_MS = 10_000;

/** Timeout (ms) for detecting the "Continue with Google" button on the auth page. */
const GOOGLE_BUTTON_TIMEOUT_MS = 10_000;

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
      const page = await browser.getPage(quiet);
      const promptInput = page.locator(SELECTORS.PROMPT_INPUT);
      await promptInput.waitFor({ state: 'visible', timeout: 5_000 });
      return true;
    } catch (error: unknown) {
      // Only treat timeout (prompt not visible yet) as "not logged in".
      // Connection/selector errors should fail fast instead of waiting 5 min.
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }
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
 * Check whether the user is already logged in by looking for the prompt textarea.
 * Returns true if the prompt input is visible (user is logged in).
 */
async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  try {
    const promptInput = page.locator(SELECTORS.PROMPT_INPUT);
    await promptInput.waitFor({ state: 'visible', timeout: 5_000 });
    return true;
  } catch (e: unknown) {
    if (e instanceof errors.TimeoutError) {
      return false;
    }
    throw e;
  }
}

/**
 * Navigate to the Google login screen for new users.
 *
 * Flow:
 * 1. Detect if the user is already logged in — if so, skip
 * 2. Click the "Log in" button on ChatGPT's landing page
 * 3. Click "Continue with Google" on the auth page
 * 4. Present the Google login screen to the user (credentials are the user's responsibility)
 *
 * Gracefully falls back to manual login if any step fails (button not found, etc.)
 */
async function navigateToGoogleLogin(page: Page, quiet: boolean): Promise<void> {
  // Step 1: Check if already logged in
  if (await isAlreadyLoggedIn(page)) {
    progress('Already logged in to ChatGPT', quiet);
    return;
  }

  // Step 2: Click "Log in" button
  progress('Detecting login button...', quiet);
  const loginButton = page.locator(SELECTORS.LOGIN_BUTTON);
  try {
    await loginButton.waitFor({ state: 'visible', timeout: LOGIN_BUTTON_TIMEOUT_MS });
  } catch (e: unknown) {
    if (e instanceof errors.TimeoutError) {
      progress('Login button not found — please log in manually in the browser', quiet);
      return;
    }
    throw e;
  }

  progress('Clicking "Log in"...', quiet);
  await loginButton.click();

  // Step 3: Wait for auth page and click "Continue with Google"
  progress('Waiting for auth page...', quiet);
  const googleButton = page.locator(SELECTORS.CONTINUE_WITH_GOOGLE).first();
  try {
    await googleButton.waitFor({ state: 'visible', timeout: GOOGLE_BUTTON_TIMEOUT_MS });
  } catch (e: unknown) {
    if (e instanceof errors.TimeoutError) {
      progress('"Continue with Google" button not found — please choose a login method manually', quiet);
      return;
    }
    throw e;
  }

  progress('Clicking "Continue with Google"...', quiet);
  await googleButton.click();

  progress('Google login page presented — please enter your credentials in the browser', quiet);
}

/**
 * Close any Chrome process listening on the CDP port by sending the
 * `Browser.close` CDP command, which actually terminates the Chrome
 * process.  (`browser.close()` on a CDP connection only disconnects
 * the client without stopping Chrome.)
 *
 * Needed after profile reset so that the stale Chrome process (still
 * using the old profile in memory) is terminated before re-launch.
 */
async function killExistingChrome(quiet: boolean): Promise<void> {
  try {
    const { chromium } = await import('playwright');
    progress('Stopping existing Chrome process...', quiet);
    const browser = await chromium.connectOverCDP(CDP_BASE_URL);
    try {
      const cdpSession = await browser.newBrowserCDPSession();
      await cdpSession.send('Browser.close');
    } finally {
      await browser.close();
    }
    // Give Chrome a moment to fully shut down
    await new Promise((r) => setTimeout(r, 1_000));
    progress('Chrome process stopped', quiet);
  } catch {
    // Chrome not running or can't connect — that's fine
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
 * Connect to Chrome, optionally navigate to Google login, verify login, and return the init result.
 */
async function setupAndVerify(quiet: boolean, skipLogin: boolean): Promise<InitResult> {
  const browser = new BrowserManager();

  try {
    progress('Connecting to Chrome...', quiet);
    const page = await browser.getPage(quiet);
    progress('Chrome is ready', quiet);

    if (!skipLogin) {
      await navigateToGoogleLogin(page, quiet);
    }

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
    skipLogin: {
      type: 'boolean',
      description: 'Skip auto-navigation to Google login (manual login only)',
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

    const skipLogin = args.skipLogin === true;

    if (args.dryRun === true) {
      const steps = skipLogin
        ? ['check_profile', 'connect_chrome', 'verify_login']
        : ['check_profile', 'connect_chrome', 'navigate_google_login', 'verify_login'];
      if (format === 'json') {
        jsonRaw({ dryRun: true, steps });
      } else {
        const action = args.reset === true ? 'reset and reinitialize' : 'initialize';
        progress(`[dry-run] Would ${action} Chrome profile at ${CHROME_PROFILE_DIR}`, quiet);
      }
      return;
    }

    try {
      if (args.reset === true) {
        await killExistingChrome(quiet);
        handleProfileReset(quiet);
      }

      reportProfileStatus(quiet);
      const result = await setupAndVerify(quiet, skipLogin);
      outputResult(result, format);

      if (!result.loggedIn) {
        process.exitCode = 1;
      }
    } catch (error: unknown) {
      fail(`Chrome setup failed: ${errorMessage(error)}. Ensure Chrome is installed and port 9222 is free.`);
    }
  },
});
