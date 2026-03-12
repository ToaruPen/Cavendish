import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Track registerCleanup calls across tests
let cleanupCallbacks: (() => void | Promise<void>)[] = [];
let unregisterFns: (() => void)[] = [];

// Mock modules before importing withDriver
vi.mock('../src/core/browser-manager.js', () => {
  const mockClosePage = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockGetPage = vi.fn().mockResolvedValue({ url: () => 'https://chatgpt.com' });

  return {
    BrowserManager: vi.fn(() => ({
      getPage: mockGetPage,
      closePage: mockClosePage,
      close: mockClose,
    })),
  };
});

vi.mock('../src/core/chatgpt-driver.js', () => ({
  ChatGPTDriver: vi.fn(() => ({})),
}));

vi.mock('../src/core/output-handler.js', () => ({
  failStructured: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock('../src/core/process-lock.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('../src/core/shutdown.js', () => ({
  registerCleanup: vi.fn((fn: () => void | Promise<void>) => {
    cleanupCallbacks.push(fn);
    const unregister = vi.fn((): void => {
      const idx = cleanupCallbacks.indexOf(fn);
      if (idx >= 0) {
        cleanupCallbacks.splice(idx, 1);
      }
    });
    unregisterFns.push(unregister);
    return unregister;
  }),
}));

describe('withDriver cleanup registration', () => {
  beforeEach(() => {
    cleanupCallbacks = [];
    unregisterFns = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a cleanup callback after getPage succeeds', async () => {
    const { withDriver } = await import('../src/core/with-driver.js');
    const { registerCleanup } = await import('../src/core/shutdown.js');

    await withDriver(true, () => Promise.resolve());

    expect(registerCleanup).toHaveBeenCalledOnce();
    expect(typeof (registerCleanup as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('function');
  });

  it('unregisters the cleanup callback in the finally block', async () => {
    const { withDriver } = await import('../src/core/with-driver.js');

    await withDriver(true, () => Promise.resolve());

    // The unregister function should have been called once in the finally block
    expect(unregisterFns).toHaveLength(1);
    expect(unregisterFns[0]).toHaveBeenCalledOnce();
  });

  it('unregisters cleanup even when the action throws', async () => {
    const { withDriver } = await import('../src/core/with-driver.js');

    await withDriver(
      true,
      () => Promise.reject(new Error('action failed')),
    );

    // failStructured handles the error; unregister should still be called
    expect(unregisterFns).toHaveLength(1);
    expect(unregisterFns[0]).toHaveBeenCalledOnce();
  });

  it('cleanup callback calls browser.closePage()', async () => {
    const { withDriver } = await import('../src/core/with-driver.js');
    const { BrowserManager } = await import('../src/core/browser-manager.js');
    const { registerCleanup } = await import('../src/core/shutdown.js');

    // Intercept the unregister to prevent removal so we can invoke the callback
    let capturedCallback: (() => void | Promise<void>) | undefined;
    (registerCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (fn: () => void | Promise<void>) => {
        capturedCallback = fn;
        return vi.fn();
      },
    );

    await withDriver(true, () => Promise.resolve());

    expect(capturedCallback).toBeDefined();
    // Invoke the captured cleanup callback
    await capturedCallback?.();

    // Verify it called closePage on the BrowserManager instance
    const browserInstance = (BrowserManager as ReturnType<typeof vi.fn>).mock.results[0].value as {
      closePage: ReturnType<typeof vi.fn>;
    };
    expect(browserInstance.closePage).toHaveBeenCalled();
  });

  it('registers and unregisters cleanup even when getPage fails', async () => {
    const { BrowserManager } = await import('../src/core/browser-manager.js');
    (BrowserManager as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      getPage: vi.fn().mockRejectedValue(new Error('connection failed')),
      closePage: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    const { withDriver } = await import('../src/core/with-driver.js');
    const { registerCleanup } = await import('../src/core/shutdown.js');

    await withDriver(true, () => Promise.resolve());

    // Cleanup is now registered before getPage, so it's always called
    expect(registerCleanup).toHaveBeenCalledOnce();
    // Unregister should still be called in the finally block
    expect(unregisterFns).toHaveLength(1);
    expect(unregisterFns[0]).toHaveBeenCalledOnce();
  });
});
