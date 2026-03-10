import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for waitForCdp() — verifies that the CDP health-check fetch
 * uses AbortSignal.timeout() so a hanging port cannot block the CLI forever.
 *
 * BrowserManager.waitForCdp is private, so we test it indirectly through
 * the public launch() path. We mock external dependencies (child_process,
 * fs, playwright, output-handler) to isolate the fetch behavior.
 */

/* ---------- shared state ---------- */

let fetchCalls: { url: string; signal: AbortSignal | undefined }[];

beforeEach(() => {
  fetchCalls = [];
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ---------- helpers ---------- */

interface MinimalBrowser {
  contexts: () => { pages: () => never[] }[];
  close: () => Promise<void>;
}

/**
 * Import BrowserManager with all heavy dependencies stubbed out.
 * The global `fetch` is replaced with `fakeFetch` so we can control
 * CDP health-check responses.
 */
async function importWithMocks(
  fakeFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ BrowserManager: typeof import('../src/core/browser-manager.js').BrowserManager }> {
  vi.resetModules();

  // Stub child_process so launch() doesn't spawn real Chrome
  vi.doMock('node:child_process', () => ({
    execFileSync: (): string => '',
    spawn: (): { pid: number; unref: () => void; once: (evt: string, cb: () => void) => void } => ({
      pid: 12345,
      unref: (): void => { /* noop stub */ },
      once: (evt: string, cb: () => void): void => {
        if (evt === 'spawn') {
          // Simulate immediate spawn success
          queueMicrotask(cb);
        }
      },
    }),
  }));

  // Stub fs so ensureProfileDirectories / saveCdpEndpoint don't touch disk.
  // readFileSync returns a fake DevToolsActivePort content (port on first line).
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...real,
      mkdirSync: (): undefined => undefined,
      chmodSync: (): undefined => undefined,
      existsSync: (): boolean => true,
      readFileSync: (): string => '54321\n/devtools/browser/fake-id',
      writeFileSync: (): undefined => undefined,
    };
  });

  // Stub output-handler to silence progress messages
  vi.doMock('../src/core/output-handler.js', () => ({
    progress: (): undefined => undefined,
    verbose: (): undefined => undefined,
  }));

  // Stub playwright so connect() after waitForCdp succeeds
  const stubBrowser: MinimalBrowser = {
    contexts: (): { pages: () => never[] }[] => [{ pages: (): never[] => [] }],
    close: (): Promise<void> => Promise.resolve(),
  };
  vi.doMock('playwright', () => ({
    chromium: {
      connectOverCDP: (): Promise<MinimalBrowser> => Promise.resolve(stubBrowser),
    },
  }));

  // Replace global fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, signal: init?.signal ?? undefined });
    return fakeFetch(url, init);
  });

  const mod = await import('../src/core/browser-manager.js');
  return { BrowserManager: mod.BrowserManager };
}

/* ---------- tests ---------- */

describe('waitForCdp fetch timeout', () => {
  it('passes an AbortSignal to every fetch call', async () => {
    const { BrowserManager } = await importWithMocks(
      (_url: string, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
    );

    const bm = new BrowserManager();
    await bm.launch(true);

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of fetchCalls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('retries and throws when every fetch attempt fails', async () => {
    vi.useFakeTimers();

    // Simulate an immediate network error (e.g. ECONNREFUSED) on every
    // attempt. This exercises the same retry+throw path that a real
    // AbortSignal.timeout would trigger, without waiting for real timers
    // (AbortSignal.timeout uses Node-internal timers that fake timers
    // cannot intercept).
    const { BrowserManager } = await importWithMocks(
      (_url: string, _init?: RequestInit): Promise<Response> => {
        return Promise.reject(new TypeError('fetch failed'));
      },
    );

    const bm = new BrowserManager();

    // Start launch and advance timers concurrently so the retry
    // setTimeout calls resolve without real delays.
    const [result] = await Promise.allSettled([
      bm.launch(true),
      // Advance past all 3 retry intervals (5 000 ms each).
      // runAllTimersAsync drains every pending timer, including those
      // enqueued during the run.
      vi.runAllTimersAsync(),
    ]);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(Error);
      expect((result.reason as Error).message).toMatch(
        /did not start a CDP endpoint/,
      );
    }

    // All 3 retry attempts should have been made with abort signals
    expect(fetchCalls).toHaveLength(3);
    for (const call of fetchCalls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }

    vi.useRealTimers();
  });

  it('does not abort signal before fetch resolves on success', async () => {
    const { BrowserManager } = await importWithMocks(
      (_url: string, init?: RequestInit): Promise<Response> => {
        // Verify the signal is not yet aborted at the time fetch resolves
        expect(init?.signal?.aborted).toBe(false);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    );

    const bm = new BrowserManager();
    await bm.launch(true);
  });
});
