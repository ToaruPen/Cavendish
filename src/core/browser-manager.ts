import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

import { progress } from './output-handler.js';

const CAVENDISH_DIR = join(homedir(), '.cavendish');
const CHROME_PROFILE_DIR = join(CAVENDISH_DIR, 'chrome-profile');
const CDP_ENDPOINT_FILE = join(CAVENDISH_DIR, 'cdp-endpoint.json');
const CHATGPT_URL = 'https://chatgpt.com';
const CDP_PORT = 9222;
const CDP_BASE_URL = `http://127.0.0.1:${String(CDP_PORT)}`;

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
  private persistentContext: BrowserContext | null = null;

  /**
   * Get a Page navigated to chatgpt.com.
   * Connects to an existing Chrome or launches a new one.
   */
  async getPage(quiet = false): Promise<Page> {
    if (!this.browser && !this.persistentContext) {
      await this.ensureConnected(quiet);
    }

    const context = this.getContext();
    if (!context) {
      throw new Error('Failed to connect to Chrome');
    }

    // Reuse existing chatgpt.com tab
    for (const page of context.pages()) {
      if (page.url().startsWith(CHATGPT_URL)) {
        return page;
      }
    }

    // No chatgpt.com tab found — open one
    const page = await context.newPage();
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
    return page;
  }

  /**
   * Launch system Chrome with a persistent profile.
   * Login sessions are stored in `~/.cavendish/chrome-profile`.
   */
  async launch(quiet = false): Promise<void> {
    progress('Launching Chrome with persistent profile...', quiet);

    mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

    const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      args: [
        `--remote-debugging-port=${String(CDP_PORT)}`,
        '--remote-debugging-address=127.0.0.1',
        // Suppress automation detection flags to avoid Cloudflare blocks
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    this.persistentContext = context;
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
   * Close the Playwright connection (does NOT kill a CDP-connected Chrome).
   * For launched Chrome, the process is terminated but the profile persists.
   */
  async close(): Promise<void> {
    if (this.persistentContext) {
      await this.persistentContext.close();
      this.persistentContext = null;
    }
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
   * Get a usable BrowserContext from either connection type.
   */
  private getContext(): BrowserContext | null {
    if (this.persistentContext) {
      return this.persistentContext;
    }
    if (this.browser) {
      const contexts = this.browser.contexts();
      return contexts[0] ?? null;
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
