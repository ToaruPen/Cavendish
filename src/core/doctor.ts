/**
 * Doctor — shared diagnostic check logic used by both `status` and `doctor` commands.
 *
 * Runs a series of health checks against CLI prerequisites and the ChatGPT
 * environment, returning structured results with pass/fail/skip status and
 * actionable suggestions for failures.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { CHATGPT_BASE_URL, SELECTORS } from '../constants/selectors.js';

import { BrowserManager, CAVENDISH_DIR, CDP_BASE_URL, CDP_PORT, CHROME_PROFILE_DIR } from './browser-manager.js';
import { errorMessage, progress } from './output-handler.js';

const CONFIG_FILE = join(CAVENDISH_DIR, 'config.json');

/** Timeout for individual doctor checks (ms). */
const DOCTOR_CHECK_TIMEOUT_MS = 5_000;

// ── Types ─────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  action?: string;
}

export interface DoctorSummary {
  total: number;
  pass: number;
  fail: number;
  skip: number;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  summary: DoctorSummary;
}

// ── Baseline checks (no Playwright needed) ────────────────

async function checkCdp(): Promise<DoctorCheck> {
  try {
    const res = await fetch(`${CDP_BASE_URL}/json/version`);
    if (res.ok) {
      const data = (await res.json()) as { Browser?: string };
      const chrome = data.Browser ?? 'unknown';
      return { name: 'chrome_cdp', status: 'pass', detail: `Connected (${chrome})` };
    }
    return {
      name: 'chrome_cdp',
      status: 'fail',
      detail: `HTTP ${String(res.status)}`,
      action: `Start Chrome with --remote-debugging-port=${String(CDP_PORT)}`,
    };
  } catch (error: unknown) {
    return {
      name: 'chrome_cdp',
      status: 'fail',
      detail: `Not running: ${errorMessage(error)}`,
      action: `Start Chrome with --remote-debugging-port=${String(CDP_PORT)}`,
    };
  }
}

function checkProfile(): DoctorCheck {
  const exists = existsSync(CHROME_PROFILE_DIR);
  return {
    name: 'profile_dir',
    status: exists ? 'pass' : 'fail',
    detail: exists ? CHROME_PROFILE_DIR : 'not found',
    action: exists ? undefined : `Run "cavendish ask" once to create ${CHROME_PROFILE_DIR}`,
  };
}

function checkConfig(): DoctorCheck {
  const exists = existsSync(CONFIG_FILE);
  return {
    name: 'config_file',
    status: exists ? 'pass' : 'skip',
    detail: exists ? CONFIG_FILE : 'not found (optional)',
  };
}

// ── Playwright-based doctor checks ────────────────────────

/**
 * Check if the current page is a Cloudflare challenge page.
 */
async function checkCloudflare(page: Page): Promise<DoctorCheck> {
  try {
    const turnstile = page.locator(SELECTORS.CF_TURNSTILE_IFRAME);
    const challengeForm = page.locator(SELECTORS.CF_CHALLENGE_FORM);

    const [turnstileCount, challengeCount] = await Promise.all([
      turnstile.count(),
      challengeForm.count(),
    ]);

    if (turnstileCount > 0 || challengeCount > 0) {
      return {
        name: 'cloudflare',
        status: 'fail',
        detail: 'Cloudflare challenge detected',
        action: 'Complete the Cloudflare challenge in Chrome manually, then retry',
      };
    }

    return { name: 'cloudflare', status: 'pass', detail: 'No challenge detected' };
  } catch (error: unknown) {
    return {
      name: 'cloudflare',
      status: 'fail',
      detail: `Check failed: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check if the page shows a login/auth screen.
 */
async function checkAuth(page: Page): Promise<DoctorCheck> {
  try {
    const url = page.url();

    // URL-based detection: /auth/ path indicates login page
    if (url.includes('/auth/')) {
      return {
        name: 'auth_status',
        status: 'fail',
        detail: 'Login page detected (URL contains /auth/)',
        action: 'Log in to ChatGPT in Chrome, then retry',
      };
    }

    // DOM-based detection: login button presence
    const loginBtn = page.locator(SELECTORS.LOGIN_BUTTON);
    const loginCount = await loginBtn.count();
    if (loginCount > 0) {
      return {
        name: 'auth_status',
        status: 'fail',
        detail: 'Login button detected — not logged in',
        action: 'Log in to ChatGPT in Chrome, then retry',
      };
    }

    return { name: 'auth_status', status: 'pass', detail: 'Authenticated' };
  } catch (error: unknown) {
    return {
      name: 'auth_status',
      status: 'fail',
      detail: `Check failed: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check that the prompt textarea is visible and interactive.
 */
async function checkPromptTextarea(page: Page): Promise<DoctorCheck> {
  try {
    const input = page.locator(SELECTORS.PROMPT_INPUT);
    await input.waitFor({ state: 'visible', timeout: DOCTOR_CHECK_TIMEOUT_MS });
    return { name: 'prompt_textarea', status: 'pass', detail: 'Visible' };
  } catch (error: unknown) {
    return {
      name: 'prompt_textarea',
      status: 'fail',
      detail: `Not visible within timeout: ${errorMessage(error)}`,
      action: 'Navigate to chatgpt.com and ensure you are logged in',
    };
  }
}

/**
 * Check that the model picker button exists on the page.
 */
async function checkModelPicker(page: Page): Promise<DoctorCheck> {
  try {
    const btn = page.locator(SELECTORS.MODEL_SELECTOR_BUTTON);
    await btn.waitFor({ state: 'attached', timeout: DOCTOR_CHECK_TIMEOUT_MS });
    return { name: 'model_picker', status: 'pass', detail: 'Available' };
  } catch (error: unknown) {
    return {
      name: 'model_picker',
      status: 'fail',
      detail: `Not found within timeout: ${errorMessage(error)}`,
      action: 'Ensure ChatGPT page is fully loaded and you have a Plus/Team plan',
    };
  }
}

/**
 * Check if the Google Drive menu item is accessible via the composer + menu.
 */
async function checkGoogleDrive(page: Page): Promise<DoctorCheck> {
  try {
    const plusBtn = page.locator(SELECTORS.COMPOSER_PLUS_BUTTON);
    const plusCount = await plusBtn.count();
    if (plusCount === 0) {
      return {
        name: 'gdrive_picker',
        status: 'skip',
        detail: 'Composer + button not found',
      };
    }

    // Check for the GitHub footer button pattern — Google Drive is a menu item,
    // but we only check that the + button exists and is clickable.
    // Full menu traversal would be invasive, so we just verify the entry point.
    return { name: 'gdrive_picker', status: 'pass', detail: 'Composer + button available' };
  } catch (error: unknown) {
    return {
      name: 'gdrive_picker',
      status: 'skip',
      detail: `Check failed: ${errorMessage(error)}`,
    };
  }
}

/**
 * Check if the GitHub footer button exists in the composer.
 */
async function checkGitHub(page: Page): Promise<DoctorCheck> {
  try {
    const btn = page.locator(SELECTORS.GITHUB_FOOTER_BUTTON);
    const count = await btn.count();
    if (count > 0) {
      return { name: 'github_picker', status: 'pass', detail: 'GitHub button found in composer footer' };
    }
    return {
      name: 'github_picker',
      status: 'skip',
      detail: 'GitHub button not found (requires agent mode or GitHub-enabled model)',
    };
  } catch (error: unknown) {
    return {
      name: 'github_picker',
      status: 'skip',
      detail: `Check failed: ${errorMessage(error)}`,
    };
  }
}

// ── Orchestration ─────────────────────────────────────────

const PLAYWRIGHT_CHECK_NAMES = [
  'cloudflare',
  'auth_status',
  'prompt_textarea',
  'model_picker',
  'gdrive_picker',
  'github_picker',
] as const;

/**
 * Build skip entries for all Playwright-based checks.
 */
function skipPlaywrightChecks(detail: string): DoctorCheck[] {
  return PLAYWRIGHT_CHECK_NAMES.map((name) => ({
    name,
    status: 'skip' as const,
    detail,
  }));
}

/**
 * Run all Playwright-based doctor checks against the current page.
 * Checks are ordered by priority: blocking issues first, optional features last.
 */
async function runPlaywrightChecks(page: Page): Promise<DoctorCheck[]> {
  // Run blocking checks sequentially (auth/CF must pass before others make sense)
  const cloudflare = await checkCloudflare(page);
  const auth = await checkAuth(page);

  // If Cloudflare or auth fails, skip interactive checks
  if (cloudflare.status === 'fail' || auth.status === 'fail') {
    return [
      cloudflare,
      auth,
      { name: 'prompt_textarea', status: 'skip', detail: 'Skipped due to auth/Cloudflare failure' },
      { name: 'model_picker', status: 'skip', detail: 'Skipped due to auth/Cloudflare failure' },
      { name: 'gdrive_picker', status: 'skip', detail: 'Skipped due to auth/Cloudflare failure' },
      { name: 'github_picker', status: 'skip', detail: 'Skipped due to auth/Cloudflare failure' },
    ];
  }

  // Run interactive checks in parallel
  const [prompt, model, gdrive, github] = await Promise.all([
    checkPromptTextarea(page),
    checkModelPicker(page),
    checkGoogleDrive(page),
    checkGitHub(page),
  ]);

  return [cloudflare, auth, prompt, model, gdrive, github];
}

/**
 * Collect all doctor checks: baseline + Playwright-based.
 */
export async function collectDoctorChecks(quiet: boolean): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Baseline checks (no Playwright)
  const cdp = await checkCdp();
  checks.push(cdp);
  checks.push(checkProfile());
  checks.push(checkConfig());

  // If CDP is not connected, skip Playwright checks
  if (cdp.status !== 'pass') {
    checks.push(...skipPlaywrightChecks('Skipped — no Chrome CDP connection'));
    return checks;
  }

  // Connect to Chrome and run Playwright checks
  const browser = new BrowserManager();
  try {
    progress('Connecting to Chrome for doctor checks...', quiet);
    await browser.connect(quiet);
    const page = await browser.getPage(quiet);

    // Ensure we are on a ChatGPT page
    if (!page.url().startsWith(CHATGPT_BASE_URL)) {
      progress('Navigating to ChatGPT...', quiet);
      await page.goto(CHATGPT_BASE_URL, { waitUntil: 'domcontentloaded' });
    }

    const playwrightChecks = await runPlaywrightChecks(page);
    checks.push(...playwrightChecks);
  } catch (error: unknown) {
    const detail = `Playwright connection failed: ${errorMessage(error)}`;
    checks.push(...skipPlaywrightChecks(detail));
  } finally {
    await browser.close();
  }

  return checks;
}

export function buildSummary(checks: DoctorCheck[]): DoctorSummary {
  return {
    total: checks.length,
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    skip: checks.filter((c) => c.status === 'skip').length,
  };
}

export function buildDoctorResult(checks: DoctorCheck[]): DoctorResult {
  return { checks, summary: buildSummary(checks) };
}

// ── Text formatting ───────────────────────────────────────

const STATUS_ICONS: Record<CheckStatus, string> = {
  pass: '\u2713',  // checkmark
  fail: '\u2717',  // ballot x
  skip: '-',
};

function formatCheckLine(check: DoctorCheck): string {
  const icon = STATUS_ICONS[check.status];
  const name = check.name.padEnd(18);
  const detail = check.detail ?? '';
  const action = check.action ? `  -> ${check.action}` : '';
  return `${icon} ${name} ${detail}${action}`;
}

export function formatTextOutput(result: DoctorResult): string[] {
  const lines = result.checks.map(formatCheckLine);
  lines.push('');
  lines.push(
    `Total: ${String(result.summary.total)}  `
    + `Pass: ${String(result.summary.pass)}  `
    + `Fail: ${String(result.summary.fail)}  `
    + `Skip: ${String(result.summary.skip)}`,
  );
  return lines;
}
