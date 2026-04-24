/**
 * Structured error types for agent-oriented error reporting.
 *
 * Each error is classified into a category with a distinct exit code,
 * enabling calling agents to handle errors programmatically.
 */

/** Error categories matching docs/plan.md §7. */
export type ErrorCategory =
  | 'cdp_unavailable'
  | 'chrome_not_found'
  | 'chrome_launch_failed'
  | 'chrome_close_failed'
  | 'auth_expired'
  | 'cloudflare_blocked'
  | 'browser_disconnected'
  | 'selector_miss'
  | 'job_no_progress'
  | 'runner_killed'
  | 'timeout'
  | 'unknown';

/** Mapping from error category to process exit code. */
export const EXIT_CODES: Readonly<Record<ErrorCategory, number>> = {
  unknown: 1,
  cdp_unavailable: 2,
  chrome_not_found: 3,
  auth_expired: 4,
  cloudflare_blocked: 5,
  selector_miss: 6,
  timeout: 7,
  chrome_launch_failed: 8,
  chrome_close_failed: 9,
  browser_disconnected: 10,
  runner_killed: 11,
  job_no_progress: 12,
};

/** Suggested user actions per error category. */
const DEFAULT_ACTIONS: Readonly<Record<ErrorCategory, string>> = {
  cdp_unavailable:
    'Run "cavendish init" to start Chrome or run "cavendish status" to check.',
  chrome_not_found:
    'Install Google Chrome and ensure it is in your PATH.',
  chrome_launch_failed:
    'Check Chrome permissions and ensure no other process is blocking the launch. Run "cavendish init" to re-detect Chrome settings.',
  chrome_close_failed:
    'Close Chrome manually before running --reset.',
  auth_expired:
    'Open Chrome and log in to ChatGPT, then retry.',
  cloudflare_blocked:
    'Open the ChatGPT tab in Chrome and solve the Cloudflare challenge manually.',
  browser_disconnected:
    'Chrome was closed or crashed. Restart Chrome and re-run the command.',
  selector_miss:
    'ChatGPT UI may have changed. Run "cavendish status" and check for updates.',
  job_no_progress:
    'Inspect the detached job events, then restart Chrome and retry the job if no worker is active.',
  runner_killed:
    'Restart the detached job; the runner process was interrupted before it could finish.',
  timeout:
    'Increase --timeout or check if ChatGPT is responding in the browser.',
  unknown:
    'Check the error message for details.',
};

/** JSON structure written to stderr when --format json. */
export interface StructuredErrorPayload {
  error: true;
  category: ErrorCategory;
  message: string;
  exitCode: number;
  action: string;
}

/**
 * Typed error with a category, exit code, and suggested user action.
 * Throw this from any layer; the top-level handler will format it.
 */
export class CavendishError extends Error {
  readonly category: ErrorCategory;
  readonly action: string;

  constructor(
    message: string,
    category: ErrorCategory,
    action?: string,
  ) {
    super(message);
    this.name = 'CavendishError';
    this.category = category;
    this.action = action ?? DEFAULT_ACTIONS[category];
  }

  /** Build the JSON payload for structured output. */
  toPayload(): StructuredErrorPayload {
    return {
      error: true,
      category: this.category,
      message: this.message,
      exitCode: EXIT_CODES[this.category],
      action: this.action,
    };
  }
}

/**
 * Classify a generic Error into a CavendishError.
 * Inspects the error message to infer the most likely category.
 * Returns the original error unchanged if it is already a CavendishError.
 */
export function classifyError(error: unknown): CavendishError {
  if (error instanceof CavendishError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Browser/CDP target closure must be checked before selector classifiers:
  // Playwright often includes "waiting for locator" in the same message.
  if (
    lower.includes('target page, context or browser has been closed') ||
    lower.includes('target closed') ||
    lower.includes('browser has been closed') ||
    lower.includes('page has been closed')
  ) {
    return new CavendishError(message, 'browser_disconnected');
  }

  // CDP / Chrome connection errors
  if (
    lower.includes('did not start a cdp endpoint') ||
    lower.includes('failed to connect to chrome') ||
    lower.includes('econnrefused') ||
    lower.includes('connectovercdp')
  ) {
    return new CavendishError(message, 'cdp_unavailable');
  }

  // Chrome not installed
  if (
    lower.includes('chrome not found') ||
    lower.includes('chrome binary not found')
  ) {
    return new CavendishError(message, 'chrome_not_found');
  }

  // Chrome launch failure (permission denied, other spawn errors)
  if (
    lower.includes('failed to launch chrome') ||
    lower.includes('permission denied launching chrome')
  ) {
    return new CavendishError(message, 'chrome_launch_failed');
  }

  // Auth / login detection — use specific phrases to avoid false positives
  // (e.g. "author-role", "authorization header" should NOT match)
  if (
    lower.includes('not logged in') ||
    lower.includes('login required') ||
    lower.includes('auth expired') ||
    lower.includes('session expired') ||
    lower.includes('log in to chatgpt') ||
    lower.includes('/auth/login')
  ) {
    return new CavendishError(message, 'auth_expired');
  }

  // Cloudflare
  if (
    lower.includes('cloudflare') ||
    lower.includes('challenge')
  ) {
    return new CavendishError(message, 'cloudflare_blocked');
  }

  // Selector / DOM misses (checked before timeout because Playwright locator
  // failures include both "Timeout ... exceeded" and "waiting for locator").
  // Use narrow patterns to avoid matching timeout messages that mention "selector"
  // in human-readable context (e.g. "check selector changes").
  if (
    lower.includes('waiting for locator') ||
    lower.includes('waiting for selector') ||
    lower.includes('not found in sidebar') ||
    lower.includes('not found in picker') ||
    lower.includes('not found in project picker') ||
    lower.includes('iframe not found') ||
    lower.includes('frame not found') ||
    lower.includes('not found (selector')
  ) {
    return new CavendishError(message, 'selector_miss');
  }

  // Timeout errors (Playwright TimeoutError or message-based detection)
  if (
    lower.includes('timeout') ||
    lower.includes('exceeded') ||
    (error instanceof Error && error.constructor.name === 'TimeoutError')
  ) {
    return new CavendishError(message, 'timeout');
  }

  return new CavendishError(message, 'unknown');
}
