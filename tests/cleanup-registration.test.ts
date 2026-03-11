import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('registerCleanup', () => {
  const registeredHandlers: { event: string; handler: (...args: unknown[]) => void }[] = [];
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    registeredHandlers.length = 0;
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      registeredHandlers.push({ event, handler });
      return process;
    }) as typeof process.on);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function findHandler(signal: 'SIGINT' | 'SIGTERM'): ((...args: unknown[]) => void) | undefined {
    return registeredHandlers.find((h) => h.event === signal)?.handler;
  }

  it('returns an unregister function', async () => {
    const { registerCleanup } = await import('../src/core/shutdown.js');
    const unregister = registerCleanup(() => undefined);
    expect(typeof unregister).toBe('function');
    unregister();
  });

  it('runs registered cleanup on SIGINT before process.exit()', async () => {
    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const cleanupFn = vi.fn();
    registerCleanup(cleanupFn);

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanupFn).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('runs registered cleanup on SIGTERM before process.exit()', async () => {
    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const cleanupFn = vi.fn();
    registerCleanup(cleanupFn);

    findHandler('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanupFn).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it('does not run unregistered cleanup on signal', async () => {
    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const cleanupFn = vi.fn();
    const unregister = registerCleanup(cleanupFn);
    unregister();

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanupFn).not.toHaveBeenCalled();
  });

  it('runs multiple cleanup callbacks even if one throws', async () => {
    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const firstFn = vi.fn();
    const throwingFn = vi.fn(() => {
      throw new Error('cleanup error');
    });
    const lastFn = vi.fn();

    registerCleanup(firstFn);
    registerCleanup(throwingFn);
    registerCleanup(lastFn);

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(firstFn).toHaveBeenCalledOnce();
    expect(throwingFn).toHaveBeenCalledOnce();
    expect(lastFn).toHaveBeenCalledOnce();
  });

  it('runs async cleanup callbacks', async () => {
    const { registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const asyncFn = vi.fn(async () => {
      await Promise.resolve();
    });
    registerCleanup(asyncFn);

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(asyncFn).toHaveBeenCalledOnce();
  });

  it('force-exits after timeout even if cleanup hangs', async () => {
    const { CLEANUP_TIMEOUT_MS, registerCleanup, registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    // Register a cleanup that never resolves
    registerCleanup(() => new Promise<void>(() => {
      // intentionally never resolves
    }));

    findHandler('SIGINT')?.();

    // Advance past the cleanup timeout
    await vi.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);

    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('exits immediately when no cleanup callbacks are registered', async () => {
    const { registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    findHandler('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('unregister is idempotent — calling it twice does not throw', async () => {
    const { registerCleanup } = await import('../src/core/shutdown.js');
    const unregister = registerCleanup(() => undefined);
    unregister();
    expect(() => {
      unregister();
    }).not.toThrow();
  });
});
