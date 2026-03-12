import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verify that signal handlers in shutdown.ts call releaseLock() AFTER
 * cleanup callbacks complete, not before. This prevents a race where
 * another process acquires the lock while this one is still closing tabs.
 */
describe('shutdown lock release ordering', () => {
  const registeredHandlers: { event: string; handler: (...args: unknown[]) => void }[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    registeredHandlers.length = 0;
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      registeredHandlers.push({ event, handler });
      return process;
    }) as typeof process.on);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function findHandler(signal: 'SIGINT' | 'SIGTERM'): ((...args: unknown[]) => void) | undefined {
    return registeredHandlers.find((h) => h.event === signal)?.handler;
  }

  it('calls releaseLock AFTER async cleanup completes on SIGINT', async () => {
    const callOrder: string[] = [];

    vi.doMock('../src/core/process-lock.js', () => ({
      releaseLock: (): void => { callOrder.push('releaseLock'); },
    }));

    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    registerCleanup(async (): Promise<void> => {
      await Promise.resolve();
      callOrder.push('cleanup');
    });

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(callOrder).toEqual(['cleanup', 'releaseLock']);
  });

  it('calls releaseLock AFTER async cleanup completes on SIGTERM', async () => {
    const callOrder: string[] = [];

    vi.doMock('../src/core/process-lock.js', () => ({
      releaseLock: (): void => { callOrder.push('releaseLock'); },
    }));

    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    registerCleanup(async (): Promise<void> => {
      await Promise.resolve();
      callOrder.push('cleanup');
    });

    findHandler('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(callOrder).toEqual(['cleanup', 'releaseLock']);
  });

  it('calls releaseLock even when cleanup callback throws', async () => {
    const callOrder: string[] = [];

    vi.doMock('../src/core/process-lock.js', () => ({
      releaseLock: (): void => { callOrder.push('releaseLock'); },
    }));

    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    registerCleanup((): void => {
      callOrder.push('cleanup');
      throw new Error('cleanup failed');
    });

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    // cleanup runs first (throws), then releaseLock still fires via .finally()
    expect(callOrder).toEqual(['cleanup', 'releaseLock']);
  });
});
