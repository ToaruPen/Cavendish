import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSignalHandlers } from '../src/core/shutdown.js';

describe('registerSignalHandlers', () => {
  // Track registered handlers directly
  const registeredHandlers: { event: string; handler: (...args: unknown[]) => void }[] = [];

  beforeEach(() => {
    registeredHandlers.length = 0;
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      registeredHandlers.push({ event, handler });
      return process;
    }) as typeof process.on);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a SIGINT handler', () => {
    registerSignalHandlers();

    const sigintEntries = registeredHandlers.filter((h) => h.event === 'SIGINT');
    expect(sigintEntries).toHaveLength(1);
    expect(typeof sigintEntries[0]?.handler).toBe('function');
  });

  it('registers a SIGTERM handler', () => {
    registerSignalHandlers();

    const sigtermEntries = registeredHandlers.filter((h) => h.event === 'SIGTERM');
    expect(sigtermEntries).toHaveLength(1);
    expect(typeof sigtermEntries[0]?.handler).toBe('function');
  });

  it('SIGINT handler exits with 130', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    registerSignalHandlers();

    const entry = registeredHandlers.find((h) => h.event === 'SIGINT');
    expect(entry).toBeDefined();
    entry?.handler();

    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('SIGTERM handler exits with 143', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    registerSignalHandlers();

    const entry = registeredHandlers.find((h) => h.event === 'SIGTERM');
    expect(entry).toBeDefined();
    entry?.handler();

    expect(exitSpy).toHaveBeenCalledWith(143);
  });
});
