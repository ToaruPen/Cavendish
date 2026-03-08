import { describe, expect, it } from 'vitest';

import {
  computeIframeWaitDeadline,
  computePhaseDeadline,
} from '../src/core/driver/helpers.js';

describe('computeIframeWaitDeadline', () => {
  const now = 1_000_000;
  const defaultMs = 15_000;

  it('caps at defaultMs when caller deadline is far away', () => {
    const callerDeadline = now + 1_800_000; // --timeout 1800s
    const result = computeIframeWaitDeadline(now, callerDeadline, defaultMs);
    expect(result).toBe(now + defaultMs);
  });

  it('falls back to default when no caller deadline', () => {
    const result = computeIframeWaitDeadline(now, undefined, defaultMs);
    expect(result).toBe(now + defaultMs);
  });

  it('respects caller deadline even when shorter than default', () => {
    const shortDeadline = now + 5_000; // only 5s left
    const result = computeIframeWaitDeadline(now, shortDeadline, defaultMs);
    expect(result).toBe(shortDeadline);
  });

  it('caps at defaultMs when caller deadline is much longer', () => {
    const longDeadline = now + 3_600_000; // 1 hour
    const result = computeIframeWaitDeadline(now, longDeadline, defaultMs);
    expect(result).toBe(now + defaultMs);
  });
});

describe('computePhaseDeadline', () => {
  const now = 1_000_000;

  it('caps at phase max when deadline is far away', () => {
    const deadline = now + 1_800_000; // --timeout 1800s
    const phaseMaxMs = 120_000; // 120s phase cap
    const result = computePhaseDeadline(now, deadline, phaseMaxMs);
    expect(result).toBe(now + phaseMaxMs);
  });

  it('uses deadline when it is sooner than phase max', () => {
    const deadline = now + 30_000; // only 30s left
    const phaseMaxMs = 120_000; // 120s phase cap
    const result = computePhaseDeadline(now, deadline, phaseMaxMs);
    expect(result).toBe(deadline);
  });

  it('returns deadline when phase max exactly equals remaining time', () => {
    const phaseMaxMs = 60_000;
    const deadline = now + phaseMaxMs;
    const result = computePhaseDeadline(now, deadline, phaseMaxMs);
    expect(result).toBe(deadline);
  });

  it('returns deadline when already past', () => {
    const pastDeadline = now - 1_000; // 1s ago
    const result = computePhaseDeadline(now, pastDeadline, 60_000);
    expect(result).toBe(pastDeadline);
  });
});
