import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

import { defineCommand } from 'citty';
import { type Browser, type Page, errors } from 'playwright';

import { CHATGPT_BASE_URL, SELECTORS } from '../constants/selectors.js';
import { BrowserManager, CHROME_PROFILE_DIR, readCdpEndpoint, resolveCdpBaseUrl } from '../core/browser-manager.js';
import { FORMAT_ARG, GLOBAL_ARGS } from '../core/cli-args.js';
import { CavendishError } from '../core/errors.js';
import { errorMessage, failStructured, jsonRaw, progress, text, validateFormat } from '../core/output-handler.js';
import { acquireLock, releaseLock } from '../core/process-lock.js';

/** Polling interval (ms) while waiting for user to log in. */
const LOGIN_POLL_INTERVAL_MS = 3_000;

/** Maximum time (ms) to wait for the user to log in before giving up. */
const LOGIN_TIMEOUT_MS = 300_000; // 5 minutes

/** Timeout (ms) for detecting the login button on the ChatGPT landing page. */
const LOGIN_BUTTON_TIMEOUT_MS = 10_000;

/** Timeout (ms) for detecting the "Continue with Google" button on the auth page. */
const GOOGLE_BUTTON_TIMEOUT_MS = 10_000;

interface InitResult {
  status: 'ready' | 'not_logged_in';
  profile: string;
  cdp: boolean;
  loggedIn: boolean;
}

/**
 * Check whether a ChatGPT tab appears logged in by querying CDP /json/list.
 * Returns true if at least one non-auth ChatGPT page is found.
 */
/** Whether a CDP probe error has already been logged (suppress duplicates during polling). */
let cdpErrorLogged = false;

async function isLoggedInViaCdp(quiet: boolean, cdpBaseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpBaseUrl}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
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
    // CDP query failed — log once (suppress duplicates during waitForLogin polling)
    if (!quiet && !cdpErrorLogged) {
      console.error(`[cavendish] CDP probe failed: ${errorMessage(error)}`);
      cdpErrorLogged = true;
    }
    return false;
  }
}

/**
 * Whether the error indicates the page/tab/browser is permanently unusable.
 * Matches Playwright errors containing "closed" (e.g. "Page closed",
 * "Browser has been closed", "Target page, context or browser has been closed").
 * Does NOT match "Execution context was destroyed" which is transient.
 *
 * Callers should use `isBrowserConnected()` to distinguish tab-close
 * (recoverable via CDP polling) from browser disconnect (fatal).
 */
function isPageClosedError(error: unknown): boolean {
  return error instanceof Error && /closed/i.test(error.message);
}

/**
 * Safely check whether the browser process behind a Page is still connected.
 * Returns false when the browser has crashed, been killed, or disconnected.
 */
function isBrowserConnected(page: Page): boolean {
  try {
    return page.context().browser()?.isConnected() ?? false;
  } catch {
    // Context/browser access may throw if already disconnected
    return false;
  }
}

/**
 * Try to find another open ChatGPT tab in the same browser context.
 * Used to recover Playwright-based prompt detection when the original
 * login tab is closed by the user.
 */
function findAlternateTab(closedPage: Page): Page | null {
  try {
    for (const p of closedPage.context().pages()) {
      if (p !== closedPage && !p.isClosed() && p.url().startsWith(CHATGPT_BASE_URL)) {
        return p;
      }
    }
  } catch {
    // Intentional: probe-and-continue — ignore errors when probing
    // browser/context state (e.g. browser disconnected, context destroyed).
  }
  return null;
}

/**
 * Whether the error is a transient Playwright navigation error
 * that can occur during OAuth redirects/reloads.
 */
function isTransientNavigationError(error: unknown): boolean {
  if (error instanceof errors.TimeoutError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return /execution context was destroyed|frame was detached|navigating/i.test(error.message);
}

/**
 * Handle errors during login prompt detection.
 * Returns an updated Page if tab recovery succeeded, or null to fall back to CDP.
 * Throws on browser disconnect or unexpected errors.
 */
function handleLoginPollError(error: unknown, currentPage: Page): Page | null {
  if (!isPageClosedError(error)) {
    if (!isTransientNavigationError(error)) {
      throw error;
    }
    return currentPage;
  }
  // Page/tab/browser closed — check if browser is still alive
  if (!isBrowserConnected(currentPage)) {
    throw new CavendishError(
      'Browser disconnected or crashed during login.',
      'cdp_unavailable',
      'Run `cavendish init` to relaunch Chrome and try again.',
    );
  }
  // Tab closed by user: try to find another open tab
  return findAlternateTab(currentPage);
}

/**
 * Wait for the prompt textarea to become visible on the page,
 * indicating that the user has logged in to ChatGPT.
 * Falls back to CDP tab-URL heuristic when Playwright detection fails.
 */
async function waitForLogin(
  page: Page,
  quiet: boolean,
): Promise<boolean> {
  progress('Waiting for ChatGPT login (open the browser and log in)...', quiet);
  cdpErrorLogged = false;

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const cdpBaseUrl = resolveCdpBaseUrl();
  let activePage: Page = page;
  let pageUsable = true;

  while (Date.now() < deadline) {
    if (pageUsable) {
      try {
        const promptInput = activePage.locator(SELECTORS.PROMPT_INPUT);
        await promptInput.waitFor({ state: 'visible', timeout: 5_000 });
        return true;
      } catch (error: unknown) {
        const recovered = handleLoginPollError(error, activePage);
        if (recovered) {
          activePage = recovered;
        } else {
          pageUsable = false;
        }
      }
    }

    if (await isLoggedInViaCdp(quiet, cdpBaseUrl)) {
      return true;
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
  await page.waitForLoadState('domcontentloaded');

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
async function waitForChromeShutdown(cdpUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Chrome is still responding at ${cdpUrl} after ${String(timeoutMs)}ms`,
  );
}

/** Resolve the absolute path for a process-scanning command per platform. */
function resolveProcessScanner(): { cmd: string; args: string[] } | null {
  if (process.platform === 'win32') {
    // Use PowerShell's Get-CimInstance (replaces deprecated WMIC removed in Win11 24H2).
    // Resolve PowerShell path via %SystemRoot% so non-standard Windows installs work.
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const psPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (!existsSync(psPath)) {
      return null;
    }
    // Escape WQL LIKE wildcards and special characters for the filter string.
    // Order matters: escape [ before % and _ (since [%] and [_] contain brackets).
    const escapedDir = CHROME_PROFILE_DIR
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "''")
      .replaceAll('[', '[[]')
      .replaceAll('%', '[%]')
      .replaceAll('_', '[_]');
    // Require "chrome" in the command line to avoid killing non-Chrome processes.
    return {
      cmd: psPath,
      args: [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name like '%chrome%' AND CommandLine like '%--user-data-dir=${escapedDir}%'" | Select-Object -ExpandProperty ProcessId`,
      ],
    };
  }
  // macOS / Linux: pgrep may be at /usr/bin/pgrep, /bin/pgrep, or /sbin/pgrep depending on distro.
  const pgrepCandidates = ['/usr/bin/pgrep', '/bin/pgrep', '/sbin/pgrep'];
  const pgrepPath = pgrepCandidates.find((p) => existsSync(p));
  if (!pgrepPath) {
    return null;
  }
  // Escape regex metacharacters in the profile dir path so pgrep -f
  // treats them literally (e.g. ".cavendish" won't match "Xcavendish").
  const escapedDir = CHROME_PROFILE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Require "chrome" (or "chromium") in the command line to avoid killing non-Chrome processes.
  // -i: case-insensitive (macOS Chrome binary is "Google Chrome" with uppercase C).
  return {
    cmd: pgrepPath,
    args: ['-fi', '--', `(chrome|chromium).*--user-data-dir=${escapedDir}( |$)`],
  };
}

/**
 * Find Chrome PIDs that were launched with the cavendish profile directory.
 *
 * Returns:
 * - `number[]` (possibly empty) — scan succeeded; these are the matching PIDs
 * - `null` — scanner unavailable or failed; caller cannot determine Chrome state
 *
 * Uses `pgrep -f` on macOS/Linux and PowerShell `Get-CimInstance` on Windows
 * to search for Chrome processes with `--user-data-dir=<CHROME_PROFILE_DIR>`.
 *
 * @internal Exported for testing only.
 */
export function findChromeByProfileDir(): number[] | null {
  const scanner = resolveProcessScanner();
  if (!scanner) {
    return null;
  }
  try {
    const output = execFileSync(scanner.cmd, scanner.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return output
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid > 0);
  } catch (error: unknown) {
    // pgrep exits with code 1 when no processes match — this is expected.
    const exitCode = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (exitCode === 1) {
      return [];
    }
    // Any other error (timeout, spawn failure, etc.) — scanner failed.
    // The original error details (timeout vs EPERM vs syntax) are intentionally
    // collapsed to null here; the caller surfaces the "scanner unavailable"
    // CavendishError with user guidance to close Chrome manually.
    return null;
  }
}

/**
 * Kill Chrome processes by PID with best-effort SIGTERM.
 * Returns true if at least one process was signaled (or already exited).
 *
 * @internal Exported for testing only.
 */
export function killChromePids(pids: number[], quiet: boolean): boolean {
  let killed = false;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      progress(`Killed Chrome process (PID ${String(pid)})`, quiet);
      killed = true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        // Process already exited — count as success
        killed = true;
      } else {
        progress(
          `Warning: failed to kill Chrome process (PID ${String(pid)}): ${error instanceof Error ? error.message : String(error)}`,
          quiet,
        );
      }
    }
  }
  return killed;
}

/** Check if a process has exited (ESRCH). Returns true only for ESRCH. */
function hasProcessExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Remove exited PIDs from the set. */
function pruneExitedPids(remaining: Set<number>): void {
  for (const pid of [...remaining]) {
    if (hasProcessExited(pid)) {
      remaining.delete(pid);
    }
  }
}

/** Send SIGKILL to all PIDs in the set (best-effort). */
function sigkillPids(pids: Set<number>): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ESRCH = already gone, ignore
    }
  }
}

/**
 * Poll until all given PIDs have exited, or until timeoutMs elapses.
 * Uses `process.kill(pid, 0)` which throws ESRCH when the process no longer exists.
 *
 * If PIDs survive the timeout, escalates to SIGKILL and re-checks.
 * Throws CavendishError if any process still remains after escalation.
 *
 * Note: PID recycling (a new process reusing a recently-freed PID) is theoretically
 * possible but practically negligible here — the window between findChromeByProfileDir()
 * and kill is milliseconds, and the PIDs were just verified as Chrome via command-line
 * pattern matching. OS PID allocation is typically monotonically increasing with a large
 * wrap-around range (32k+ on Linux, 99999 on macOS).
 *
 * @internal Exported for testing only.
 */
export async function waitForPidExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set(pids);

  while (remaining.size > 0 && Date.now() < deadline) {
    pruneExitedPids(remaining);
    if (remaining.size > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (remaining.size === 0) {
    return;
  }

  // Escalate to SIGKILL for survivors
  sigkillPids(remaining);
  await new Promise((r) => setTimeout(r, 500));
  pruneExitedPids(remaining);

  if (remaining.size > 0) {
    throw new CavendishError(
      `Chrome process(es) did not exit in time: ${[...remaining].join(', ')}`,
      'chrome_close_failed',
      'Close Chrome manually before running --reset.',
    );
  }
}

/**
 * Scan for Chrome processes by profile directory and kill them.
 *
 * - If scanner is unavailable and `throwOnScannerFailure` is true, throws CavendishError.
 * - If scanner is unavailable and `throwOnScannerFailure` is false, silently returns.
 * - If Chrome processes are found but cannot be killed, throws CavendishError.
 */
async function killChromeByProfileScan(quiet: boolean, throwOnScannerFailure: boolean): Promise<void> {
  const pids = findChromeByProfileDir();
  if (pids === null) {
    if (throwOnScannerFailure) {
      throw new CavendishError(
        'Cannot detect running Chrome processes (process scanner unavailable).',
        'chrome_close_failed',
        'Close Chrome manually before running --reset.',
      );
    }
    return;
  }
  if (pids.length === 0) {
    progress('No running Chrome found for this profile', quiet);
    return;
  }
  const killed = killChromePids(pids, quiet);
  if (!killed) {
    throw new CavendishError(
      'Found Chrome process(es) but failed to stop them.',
      'chrome_close_failed',
      'Close Chrome manually before running --reset.',
    );
  }
  await waitForPidExit(pids, 5_000);
}

async function killExistingChrome(quiet: boolean): Promise<void> {
  const endpoint = readCdpEndpoint();
  if (!endpoint) {
    // CDP endpoint file is missing — try to find Chrome by its profile dir argument.
    progress('CDP endpoint file not found — scanning for Chrome process by profile directory...', quiet);
    await killChromeByProfileScan(quiet, true);
    return;
  }
  const cdpUrl = `http://127.0.0.1:${String(endpoint.port)}`;

  const { chromium } = await import('playwright');

  progress('Stopping existing Chrome process...', quiet);

  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (error: unknown) {
    const msg = errorMessage(error);
    if (msg.includes('ECONNREFUSED')) {
      // Stale endpoint — CDP port no longer active. Chrome may still be running
      // with a different port (e.g. after a restart), so scan by profile dir.
      progress('CDP connection refused — scanning for Chrome process by profile directory...', quiet);
      await killChromeByProfileScan(quiet, true);
      return;
    }
    throw new CavendishError(
      `Cannot connect to Chrome via CDP: ${msg}`,
      'cdp_unavailable',
      'Ensure Chrome is running with --remote-debugging-port, or run `cavendish init` to relaunch.',
    );
  }

  try {
    const cdpSession = await browser.newBrowserCDPSession();
    await cdpSession.send('Browser.close');
    await waitForChromeShutdown(cdpUrl);
    progress('Chrome process stopped', quiet);
  } catch (error: unknown) {
    throw new CavendishError(
      `Failed to stop Chrome via CDP (${error instanceof Error ? error.message : String(error)}). `
      + 'Close Chrome manually before running --reset.',
      'chrome_close_failed',
    );
  } finally {
    await browser.close().catch((error: unknown) => {
      const msg = errorMessage(error);
      if (/closed|disconnected/i.test(msg)) { return; }
      console.error(`[cavendish] browser.close() failed: ${msg}`);
    });
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

    // Keep the page open so the user can complete login in the same tab.
    // waitForLogin polls the existing page instead of creating new tabs.
    const loggedIn = await waitForLogin(page, quiet);

    if (loggedIn) {
      progress('ChatGPT login confirmed', quiet);
    } else {
      progress('Login not detected within timeout. Run "cavendish init" again after logging in.', quiet);
    }

    return {
      status: loggedIn ? 'ready' : 'not_logged_in',
      profile: CHROME_PROFILE_DIR,
      cdp: true,
      loggedIn,
    };
  } finally {
    await browser.closePage();
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
      acquireLock();

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
      failStructured(error, format);
    } finally {
      releaseLock();
    }
  },
});
