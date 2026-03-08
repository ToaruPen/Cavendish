import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('registerSignalHandlers', () => {
  // Track registered handlers directly
  const registeredHandlers: { event: string; handler: (...args: unknown[]) => void }[] = [];

  beforeEach(() => {
    // Reset module state so the idempotent guard resets between tests
    vi.resetModules();
    registeredHandlers.length = 0;
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      registeredHandlers.push({ event, handler });
      return process;
    }) as typeof process.on);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a SIGINT handler', async () => {
    const { registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const sigintEntries = registeredHandlers.filter((h) => h.event === 'SIGINT');
    expect(sigintEntries).toHaveLength(1);
    expect(typeof sigintEntries[0]?.handler).toBe('function');
  });

  it('registers a SIGTERM handler', async () => {
    const { registerSignalHandlers } = await import('../src/core/shutdown.js');
    registerSignalHandlers();

    const sigtermEntries = registeredHandlers.filter((h) => h.event === 'SIGTERM');
    expect(sigtermEntries).toHaveLength(1);
    expect(typeof sigtermEntries[0]?.handler).toBe('function');
  });

  it('SIGINT handler exits with 130', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { registerSignalHandlers } = await import('../src/core/shutdown.js');

    registerSignalHandlers();

    const entry = registeredHandlers.find((h) => h.event === 'SIGINT');
    expect(entry).toBeDefined();
    entry?.handler();

    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('SIGTERM handler exits with 143', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { registerSignalHandlers } = await import('../src/core/shutdown.js');

    registerSignalHandlers();

    const entry = registeredHandlers.find((h) => h.event === 'SIGTERM');
    expect(entry).toBeDefined();
    entry?.handler();

    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it('is idempotent — second call does not register duplicate handlers', async () => {
    const { registerSignalHandlers } = await import('../src/core/shutdown.js');

    registerSignalHandlers();
    registerSignalHandlers();

    const sigintEntries = registeredHandlers.filter((h) => h.event === 'SIGINT');
    const sigtermEntries = registeredHandlers.filter((h) => h.event === 'SIGTERM');
    expect(sigintEntries).toHaveLength(1);
    expect(sigtermEntries).toHaveLength(1);
  });
});
