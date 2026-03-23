/**
 * Shared helper functions for ChatGPTDriver sub-modules.
 */

import type { Locator, Page } from 'playwright-core';
import { errors } from 'playwright-core';

import { SELECTORS } from '../../constants/selectors.js';

export const DEFAULT_TIMEOUT_MS = Number.MAX_SAFE_INTEGER;
export const POLL_INTERVAL_MS = 200;
export const SEND_BUTTON_TIMEOUT_MS = 60_000;
export const UPLOAD_SEND_BUTTON_TIMEOUT_MS = 180_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof errors.TimeoutError;
}

interface ReadySendButton {
  selector: string;
  index: number;
}

function sendButtonSelectors(
  preferredSelector?: string,
): string[] {
  const selectors = [
    preferredSelector,
    SELECTORS.SEND_BUTTON,
    SELECTORS.SUBMIT_BUTTON,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return [...new Set(selectors)];
}

async function isReadySendButton(locator: Locator): Promise<boolean> {
  const visible = await locator.isVisible().catch((): boolean => false);
  if (!visible) {
    return false;
  }

  return locator.evaluate((el) => {
    const node = el as HTMLElement;
    const rect = node.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && !el.hasAttribute('disabled')
      && el.getAttribute('aria-disabled') !== 'true';
  }).catch((): boolean => false);
}

export async function resolveReadySendButton(
  page: Page,
  preferredSelector?: string,
): Promise<ReadySendButton | null> {
  for (const selector of sendButtonSelectors(preferredSelector)) {
    const matches = page.locator(selector);
    const count = await matches.count().catch((): number => 0);

    for (let index = 0; index < count; index++) {
      if (await isReadySendButton(matches.nth(index))) {
        return { selector, index };
      }
    }
  }

  return null;
}

export async function waitForReadySendButton(
  page: Page,
  preferredSelector?: string,
  timeoutMs: number = SEND_BUTTON_TIMEOUT_MS,
): Promise<ReadySendButton> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await resolveReadySendButton(page, preferredSelector);
    if (ready !== null) {
      return ready;
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new errors.TimeoutError(
    `No enabled send button became available within ${String(Math.round(timeoutMs / 1000))}s. `
    + `Tried selectors: ${sendButtonSelectors(preferredSelector).join(', ')}`,
  );
}

export async function clickReadySendButton(
  page: Page,
  preferredSelector?: string,
  timeoutMs: number = SEND_BUTTON_TIMEOUT_MS,
): Promise<void> {
  const target = await waitForReadySendButton(page, preferredSelector, timeoutMs);
  await page.locator(target.selector).nth(target.index).click();
}

/**
 * Check if an error is caused by a detached frame or destroyed execution context.
 * These are expected during iframe replacement in Deep Research.
 */
export function isFrameDetachedError(error: unknown): boolean {
  if (!(error instanceof Error)) { return false; }
  const msg = error.message;
  return msg.includes('frame was detached') ||
    msg.includes('Execution context was destroyed');
}

// ── Deadline helpers ────────────────────────────────────────

/**
 * Compute effective deadline for iframe wait.
 *
 * When a caller-provided deadline exists (derived from --timeout), cap the
 * wait at the shorter of `defaultMs` and the remaining caller time.  This
 * prevents a broken iframe from hanging for the full user timeout (e.g. 30m)
 * while still respecting a very short caller deadline.
 * Fall back to `defaultMs` when no caller deadline is given.
 */
export function computeIframeWaitDeadline(
  now: number,
  callerDeadline: number | undefined,
  defaultMs: number,
): number {
  const defaultDeadline = now + defaultMs;
  return callerDeadline !== undefined
    ? Math.min(callerDeadline, defaultDeadline)
    : defaultDeadline;
}

/**
 * Compute effective deadline for a sub-phase of a larger operation.
 *
 * The sub-phase is capped at `phaseMaxMs` but must not exceed the
 * overall `deadline`.  This is used for phases where a bounded wait
 * is appropriate (e.g. plan/start detection) but the user's timeout
 * still takes precedence if it is shorter.
 */
export function computePhaseDeadline(
  now: number,
  deadline: number,
  phaseMaxMs: number,
): number {
  return Math.min(deadline, now + phaseMaxMs);
}
