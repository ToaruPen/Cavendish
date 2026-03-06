import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

import { CHATGPT_BASE_URL } from '../constants/selectors.js';

import { progress } from './output-handler.js';

const CAVENDISH_DIR = join(homedir(), '.cavendish');
const CHROME_PROFILE_DIR = join(CAVENDISH_DIR, 'chrome-profile');
const CDP_ENDPOINT_FILE = join(CAVENDISH_DIR, 'cdp-endpoint.json');
const CDP_PORT = 9222;
const CDP_BASE_URL = `http://127.0.0.1:${String(CDP_PORT)}`;

const CDP_POLL_INTERVAL_MS = 500;
const CDP_POLL_TIMEOUT_MS = 15_000;

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

  /**
   * Get a Page navigated to chatgpt.com.
   * Connects to an existing Chrome or launches a new one.
   */
  async getPage(quiet = false): Promise<Page> {
    if (!this.browser) {
      await this.ensureConnected(quiet);
    }

    const context = this.getContext();
    if (!context) {
      throw new Error('Failed to connect to Chrome');
    }

    // Reuse existing chatgpt.com tab
    for (const page of context.pages()) {
      if (page.url().startsWith(CHATGPT_BASE_URL)) {
        return page;
      }
    }

    // No chatgpt.com tab found — open one
    const page = await context.newPage();
    await page.goto(CHATGPT_BASE_URL, { waitUntil: 'domcontentloaded' });
    return page;
  }

  /**
   * Launch system Chrome as a detached process and connect via CDP.
   * Chrome persists after cavendish exits so sessions survive.
   * Login sessions are stored in `~/.cavendish/chrome-profile`.
   */
  async launch(quiet = false): Promise<void> {
    progress('Launching Chrome with persistent profile...', quiet);

    mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

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

    await this.waitForCdp();
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
   */
  private async waitForCdp(): Promise<void> {
    const deadline = Date.now() + CDP_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${CDP_BASE_URL}/json/version`);
        if (res.ok) {return;}
      } catch {
        // Chrome not ready yet
      }
      await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL_MS));
    }
    throw new Error(
      `Chrome did not start within ${String(CDP_POLL_TIMEOUT_MS / 1000)}s. Check that port ${String(CDP_PORT)} is free.`,
    );
  }

  /**
   * Find the system Chrome executable path.
   */
  private findChromePath(): string {
    switch (process.platform) {
      case 'darwin':
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      case 'linux':
        return 'google-chrome';
      case 'win32':
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      default:
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
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
