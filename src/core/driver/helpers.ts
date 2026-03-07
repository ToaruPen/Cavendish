/**
 * Shared helper functions for ChatGPTDriver sub-modules.
 */

import { errors } from 'playwright';

export const DEFAULT_TIMEOUT_MS = 2_400_000;
export const POLL_INTERVAL_MS = 200;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof errors.TimeoutError;
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
