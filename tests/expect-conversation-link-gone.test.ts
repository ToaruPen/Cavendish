import { describe, expect, it, vi } from 'vitest';

import {
  DELETE_VERIFY_STABILITY_TARGET,
  DELETE_VERIFY_TIMEOUT_MS,
  expectConversationLinkGone,
} from '../src/core/chatgpt-driver.js';

describe('expectConversationLinkGone', () => {
  function fakeClock(): { now: () => number; advance: (ms: number) => void } {
    let current = 0;
    return {
      now: (): number => current,
      advance: (ms: number): void => {
        current += ms;
      },
    };
  }

  function makeSleep(clock: { advance: (ms: number) => void }): (ms: number) => Promise<void> {
    return (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
  }

  it('resolves once count() returns zero for STABILITY_TARGET consecutive polls', async () => {
    const clock = fakeClock();
    const counts = [0, 0, 0];
    const count = vi.fn((): Promise<number> => Promise.resolve(counts.shift() ?? 0));

    await expectConversationLinkGone(count, 'abc', {
      sleep: makeSleep(clock),
      now: clock.now,
    });

    expect(count).toHaveBeenCalledTimes(DELETE_VERIFY_STABILITY_TARGET);
  });

  it('resets the stability counter when the link reappears', async () => {
    // 0, 0, >0 (reset), 0, 0, 0 → resolves
    const clock = fakeClock();
    const counts = [0, 0, 1, 0, 0, 0];
    const count = vi.fn((): Promise<number> => Promise.resolve(counts.shift() ?? 0));

    await expectConversationLinkGone(count, 'abc', {
      sleep: makeSleep(clock),
      now: clock.now,
    });

    expect(count).toHaveBeenCalledTimes(6);
  });

  it('throws when the link never disappears within the timeout', async () => {
    const clock = fakeClock();
    const count = vi.fn((): Promise<number> => Promise.resolve(1));

    await expect(
      expectConversationLinkGone(count, 'abc', {
        sleep: makeSleep(clock),
        now: clock.now,
        timeoutMs: 1_000,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow(/Delete verification failed.*"abc".*not reliably removed/);
  });

  it('uses a generic error message that does not assume sidebar location', async () => {
    // Project conversations live in <main>, not the sidebar.  The error
    // message must not say "reappeared in the sidebar".
    const clock = fakeClock();
    const count = vi.fn((): Promise<number> => Promise.resolve(1));

    try {
      await expectConversationLinkGone(count, 'project-chat', {
        sleep: makeSleep(clock),
        now: clock.now,
        timeoutMs: 500,
        pollIntervalMs: 100,
      });
      expect.fail('expected the call to throw');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).not.toContain('sidebar');
      expect(message).toContain('project-chat');
    }
  });

  it('does NOT resolve after fewer than STABILITY_TARGET zero observations', async () => {
    // Only 2 consecutive zeros (below the target of 3) followed by a
    // reappearance must reset the counter and continue polling — never
    // resolve early.
    const clock = fakeClock();
    const counts = [0, 0, 1, 1, 1, 1, 1];
    const count = vi.fn((): Promise<number> => Promise.resolve(counts.shift() ?? 1));

    await expect(
      expectConversationLinkGone(count, 'abc', {
        sleep: makeSleep(clock),
        now: clock.now,
        timeoutMs: 1_000,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow();
    expect(count.mock.calls.length).toBeGreaterThan(2);
  });

  it('exposes the configured timeout in the error message', async () => {
    const clock = fakeClock();
    const count = vi.fn((): Promise<number> => Promise.resolve(1));

    try {
      await expectConversationLinkGone(count, 'abc', {
        sleep: makeSleep(clock),
        now: clock.now,
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      });
      expect.fail('expected the call to throw');
    } catch (e: unknown) {
      expect((e as Error).message).toContain('5s');
    }
  });

  it('verifies module exports the documented constants', () => {
    expect(DELETE_VERIFY_TIMEOUT_MS).toBe(5_000);
    expect(DELETE_VERIFY_STABILITY_TARGET).toBe(3);
  });
});
