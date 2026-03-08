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

// ── Deadline helpers ────────────────────────────────────────

/**
 * Compute effective deadline for iframe wait.
 *
 * When a caller-provided deadline exists (derived from --timeout), use it
 * so the user's timeout is respected.  Fall back to a short default
 * when no deadline is given (standalone / ad-hoc calls).
 */
export function computeIframeWaitDeadline(
  now: number,
  callerDeadline: number | undefined,
  defaultMs: number,
): number {
  return callerDeadline ?? (now + defaultMs);
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
