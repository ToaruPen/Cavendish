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
  | 'auth_expired'
  | 'cloudflare_blocked'
  | 'selector_miss'
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
};

/** Suggested user actions per error category. */
const DEFAULT_ACTIONS: Readonly<Record<ErrorCategory, string>> = {
  cdp_unavailable:
    'Start Chrome with --remote-debugging-port=9222 or run "cavendish status" to check.',
  chrome_not_found:
    'Install Google Chrome and ensure it is in your PATH.',
  auth_expired:
    'Open Chrome and log in to ChatGPT, then retry.',
  cloudflare_blocked:
    'Open the ChatGPT tab in Chrome and solve the Cloudflare challenge manually.',
  selector_miss:
    'ChatGPT UI may have changed. Run "cavendish status" and check for updates.',
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

  // CDP / Chrome connection errors
  if (
    message.includes('did not respond on port') ||
    message.includes('Failed to connect to Chrome') ||
    message.includes('ECONNREFUSED') ||
    message.includes('connectOverCDP')
  ) {
    return new CavendishError(message, 'cdp_unavailable');
  }

  // Chrome not installed
  if (
    message.includes('Chrome not found') ||
    message.includes('Failed to launch Chrome')
  ) {
    return new CavendishError(message, 'chrome_not_found');
  }

  // Auth / login detection — use specific phrases to avoid false positives
  // (e.g. "author-role", "authorization header" should NOT match)
  if (
    message.includes('not logged in') ||
    message.includes('Not logged in') ||
    message.includes('login required') ||
    message.includes('auth expired') ||
    message.includes('session expired') ||
    message.includes('log in to ChatGPT') ||
    message.includes('/auth/login')
  ) {
    return new CavendishError(message, 'auth_expired');
  }

  // Cloudflare
  if (
    message.includes('Cloudflare') ||
    message.includes('cloudflare') ||
    message.includes('challenge')
  ) {
    return new CavendishError(message, 'cloudflare_blocked');
  }

  // Selector / DOM misses (checked before timeout because Playwright locator
  // failures include both "Timeout ... exceeded" and "waiting for locator")
  if (
    message.includes('selector') ||
    message.includes('not found in sidebar') ||
    message.includes('not found in picker') ||
    message.includes('not found in project picker') ||
    message.includes('iframe not found') ||
    message.includes('frame not found') ||
    message.includes('not found (selector') ||
    message.includes('waiting for locator') ||
    message.includes('waiting for selector')
  ) {
    return new CavendishError(message, 'selector_miss');
  }

  // Timeout errors (Playwright TimeoutError or message-based detection)
  if (
    message.includes('Timeout') ||
    message.includes('timeout') ||
    message.includes('exceeded') ||
    (error instanceof Error && error.constructor.name === 'TimeoutError')
  ) {
    return new CavendishError(message, 'timeout');
  }

  return new CavendishError(message, 'unknown');
}
