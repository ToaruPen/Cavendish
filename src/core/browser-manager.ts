import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

import { CHATGPT_BASE_URL } from '../constants/selectors.js';

import { CavendishError } from './errors.js';
import { progress, verbose } from './output-handler.js';

export const CAVENDISH_DIR = join(homedir(), '.cavendish');
export const CHROME_PROFILE_DIR = join(CAVENDISH_DIR, 'chrome-profile');
export const CDP_ENDPOINT_FILE = join(CAVENDISH_DIR, 'cdp-endpoint.json');
export const CDP_PORT = 9222;
export const CDP_BASE_URL = `http://127.0.0.1:${String(CDP_PORT)}`;

/** Restrictive permission mask: owner-only read/write/execute. */
const DIR_MODE = 0o700;

/**
 * Ensure `~/.cavendish/` and `chrome-profile` exist with 0o700 permissions.
 *
 * - New directories are created with `mode: 0o700`.
 * - Pre-existing directories are `chmod`-ed to `0o700` to tighten
 *   permissions for users who already have the dirs at 0o755.
 *
 * @throws {Error} when directory creation or permission change fails.
 *   Callers (e.g. `launch()`) should catch and wrap as CavendishError.
 */
export function ensureProfileDirectories(): void {
  mkdirSync(CHROME_PROFILE_DIR, { recursive: true, mode: DIR_MODE });
  // Ensure correct permissions on pre-existing directories
  chmodSync(CAVENDISH_DIR, DIR_MODE);
  chmodSync(CHROME_PROFILE_DIR, DIR_MODE);
}

const CDP_MAX_RETRIES = 3;
const CDP_RETRY_INTERVAL_MS = 5_000;

interface CdpEndpointData {
  port: number;
  savedAt: string;
}

/**
 * Manages a persistent Chrome instance via Playwright.
 *
 * - First invocation: launches system Chrome with a persistent profile
 *   stored in `~/.cavendish/chrome-profile` (login session survives restarts)
 * - If Chrome is already running on the CDP port: reconnects via CDP
 * - Chrome process persists between CLI calls when connected via CDP
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private createdPage: Page | null = null;

  /**
   * Get a Page navigated to chatgpt.com.
   * Connects to an existing Chrome or launches a new one.
   *
   * @param quiet - Suppress progress output when true.
   * @param permissions - Browser permissions to grant for the ChatGPT origin
   *   (e.g. `['clipboard-read', 'clipboard-write']`). Empty by default so
   *   commands only opt in to the permissions they actually need.
   * @param isVerbose - Enable verbose diagnostic output.
   */
  async getPage(quiet = false, permissions: string[] = [], isVerbose = false): Promise<Page> {
    if (!this.browser) {
      verbose(`CDP endpoint: ${CDP_BASE_URL}`, isVerbose);
      await this.ensureConnected(quiet);
    }

    const context = this.getContext();
    if (!context) {
      throw new CavendishError(
        'Failed to connect to Chrome',
        'cdp_unavailable',
      );
    }

    // Grant browser permissions only when explicitly requested by the caller.
    // We intentionally do NOT call clearPermissions() here: the CDP context is
    // shared across all concurrent CLI processes, so clearing would revoke
    // permissions that a long-running command (e.g. Deep Research) still needs.
    // Stale permissions from a prior command are harmless — no non-DR command
    // uses clipboard APIs, so leftover grants have no observable effect.
    if (permissions.length > 0) {
      await context.grantPermissions(permissions, {
        origin: CHATGPT_BASE_URL,
      });
    }

    // Close any previously tracked page to prevent tab leaks when
    // getPage() is called more than once on the same instance.
    if (this.createdPage) {
      await this.closePage();
    }

    // Always create a new tab so parallel commands don't conflict
    verbose('Opening new ChatGPT tab...', isVerbose);
    const page = await context.newPage();
    await page.goto(CHATGPT_BASE_URL, { waitUntil: 'domcontentloaded' });
    this.createdPage = page;
    return page;
  }

  /**
   * Launch system Chrome as a detached process and connect via CDP.
   * Chrome persists after cavendish exits so sessions survive.
   * Login sessions are stored in `~/.cavendish/chrome-profile`.
   */
  async launch(quiet = false): Promise<void> {
    progress('Launching Chrome with persistent profile...', quiet);

    try {
      ensureProfileDirectories();
    } catch (err: unknown) {
      throw new CavendishError(
        `Failed to set up Chrome profile directory at "${CHROME_PROFILE_DIR}": ${err instanceof Error ? err.message : String(err)}`,
        'chrome_launch_failed',
        `Check file permissions on "${CAVENDISH_DIR}" and retry, or run "cavendish init" to reinitialize.`,
      );
    }

    const chromePath = this.findChromePath();
    const args = [
      `--remote-debugging-port=${String(CDP_PORT)}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      CHATGPT_BASE_URL,
    ];

    const child: ChildProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Wait for the process to actually start before polling CDP.
    // 'spawn' fires once the OS has successfully created the process;
    // 'error' fires if the binary is missing, not executable, etc.
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', (err: NodeJS.ErrnoException) => {
        const code = err.code;
        if (code === 'ENOENT') {
          reject(
            new CavendishError(
              `Chrome binary not found at "${chromePath}": ${err.message}`,
              'chrome_not_found',
            ),
          );
        } else if (code === 'EACCES') {
          reject(
            new CavendishError(
              `Permission denied launching Chrome at "${chromePath}": ${err.message}`,
              'chrome_launch_failed',
              'Check file permissions on the Chrome binary and retry.',
            ),
          );
        } else {
          reject(
            new CavendishError(
              `Failed to launch Chrome at "${chromePath}" (${code ?? 'unknown'}): ${err.message}`,
              'chrome_launch_failed',
            ),
          );
        }
      });
    });

    await this.waitForCdp(quiet);
    await this.connect(quiet);
    this.saveCdpEndpoint();
    progress('Chrome launched', quiet);
  }

  /**
   * Connect to a running Chrome via CDP.
   */
  async connect(quiet = false): Promise<void> {
    progress('Connecting to Chrome via CDP...', quiet);

    const browser = await chromium.connectOverCDP(CDP_BASE_URL, {
      timeout: 10_000,
    });

    this.browser = browser;
    progress('Connected to Chrome', quiet);
  }

  /**
   * Close the tab created by this instance.
   * Only closes the page, not the browser or other tabs.
   */
  async closePage(): Promise<void> {
    if (this.createdPage) {
      try {
        await this.createdPage.close();
      } catch {
        // Page may already be closed (e.g. user closed the tab manually)
      }
      this.createdPage = null;
    }
  }

  /**
   * Close the Playwright connection (does NOT kill Chrome).
   * Chrome continues running as a detached process for future CDP reconnection.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Try CDP reconnection first, fall back to launching Chrome.
   */
  private async ensureConnected(quiet: boolean): Promise<void> {
    try {
      await this.connect(quiet);
    } catch {
      progress('CDP connection failed, launching new Chrome...', quiet);
      await this.launch(quiet);
    }
  }

  /**
   * Get a usable BrowserContext from the CDP connection.
   */
  private getContext(): BrowserContext | null {
    if (this.browser) {
      const contexts = this.browser.contexts();
      return contexts[0] ?? null;
    }
    return null;
  }

  /**
   * Poll the CDP endpoint until Chrome is ready to accept connections.
   * Max 3 attempts with logging per project guidelines.
   */
  private async waitForCdp(quiet: boolean): Promise<void> {
    for (let attempt = 1; attempt <= CDP_MAX_RETRIES; attempt += 1) {
      try {
        const res = await fetch(`${CDP_BASE_URL}/json/version`);
        if (res.ok) {
          return;
        }
        progress(
          `CDP not ready (attempt ${String(attempt)}/${String(CDP_MAX_RETRIES)}): HTTP ${String(res.status)}`,
          quiet,
        );
      } catch (error: unknown) {
        progress(
          `CDP not ready (attempt ${String(attempt)}/${String(CDP_MAX_RETRIES)}): ${error instanceof Error ? error.message : String(error)}`,
          quiet,
        );
      }
      await new Promise((r) => setTimeout(r, CDP_RETRY_INTERVAL_MS));
    }
    const portHint =
      process.platform === 'win32'
        ? `netstat -ano | findstr :${String(CDP_PORT)} then taskkill /PID <pid> /F`
        : `lsof -ti :${String(CDP_PORT)} | xargs kill`;
    throw new CavendishError(
      `Chrome did not respond on port ${String(CDP_PORT)} after ${String(CDP_MAX_RETRIES)} attempts. Ensure Chrome is installed and the port is free (${portHint}).`,
      'cdp_unavailable',
    );
  }

  /**
   * Find the system Chrome executable path.
   * Checks multiple candidate paths per platform for compatibility.
   */
  private findChromePath(): string {
    const candidates: string[] = [];
    switch (process.platform) {
      case 'darwin':
        candidates.push(
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          `${homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        );
        break;
      case 'linux':
        candidates.push(
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        );
        break;
      case 'win32': {
        candidates.push(
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        );
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
          candidates.push(
            join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          );
        }
        break;
      }
      default:
        throw new Error(`Unsupported platform: ${process.platform}`);
    }

    const found = candidates.find((p) => existsSync(p));
    if (found) {
      return found;
    }

    // Fallback: probe PATH via which/where for non-standard install locations
    // (e.g. Snap, Homebrew, or other package managers)
    const pathProbe = this.findChromeOnPath();
    if (pathProbe) {
      return pathProbe;
    }

    throw new CavendishError(
      `Chrome not found. Searched: ${candidates.join(', ')} and PATH. Install Google Chrome and retry.`,
      'chrome_not_found',
    );
  }

  /**
   * Probe PATH for common Chrome/Chromium executable names.
   * Returns the resolved absolute path or null.
   */
  private findChromeOnPath(): string | null {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const names =
      process.platform === 'win32'
        ? ['chrome.exe']
        : ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];

    for (const name of names) {
      try {
        const result = execFileSync(cmd, [name], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        }).trim();
        // `where` on Windows may return multiple lines; take the first
        const firstLine = result.split('\n')[0]?.trim();
        if (firstLine && existsSync(firstLine)) {
          return firstLine;
        }
      } catch {
        // Not found on PATH, try next name
      }
    }
    return null;
  }

  /**
   * Persist CDP endpoint info for other commands (e.g. `status`).
   */
  private saveCdpEndpoint(): void {
    const data: CdpEndpointData = {
      port: CDP_PORT,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(CDP_ENDPOINT_FILE, JSON.stringify(data, null, 2));
  }
}
