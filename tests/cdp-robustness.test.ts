import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for CDP robustness improvements:
 * - #135: resolveCdpBaseUrl throws when endpoint file is missing (no 9222 fallback)
 * - #136: launch() kills orphan Chrome when CDP discovery/connection fails
 */

/* ---------- shared state ---------- */

let processKillCalls: { pid: number; signal: NodeJS.Signals | number | undefined }[];
let unlinkSyncCalls: string[];

beforeEach(() => {
  processKillCalls = [];
  unlinkSyncCalls = [];
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ---------- shared helpers ---------- */

/** Silence progress/verbose output in tests. */
function mockOutputHandler(): void {
  vi.doMock('../src/core/output-handler.js', () => ({
    progress: (): undefined => undefined,
    verbose: (): undefined => undefined,
  }));
}

/**
 * Mock `node:fs` for resolveCdpBaseUrl tests.
 * @param fileExists - Whether `existsSync` returns true.
 * @param fileContent - Content returned by `readFileSync` (or throws if absent).
 */
function mockFsForEndpoint(fileExists: boolean, fileContent?: string): void {
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...real,
      existsSync: (): boolean => fileExists,
      readFileSync: (): string => {
        if (fileContent !== undefined) {
          return fileContent;
        }
        throw new Error('ENOENT');
      },
    };
  });
}

/* ================================================================
 * #135 — resolveCdpBaseUrl throws when endpoint file is missing
 * ================================================================ */

describe('resolveCdpBaseUrl — no 9222 fallback (#135)', () => {
  it('returns the saved endpoint URL when file exists', async () => {
    mockFsForEndpoint(true, JSON.stringify({ port: 54321, savedAt: '2025-01-01T00:00:00Z' }));
    mockOutputHandler();

    const { resolveCdpBaseUrl } = await import('../src/core/browser-manager.js');
    expect(resolveCdpBaseUrl()).toBe('http://127.0.0.1:54321');
  });

  it('throws CavendishError when endpoint file is missing', async () => {
    mockFsForEndpoint(false);
    mockOutputHandler();

    const { resolveCdpBaseUrl } = await import('../src/core/browser-manager.js');
    const { CavendishError } = await import('../src/core/errors.js');

    expect(() => resolveCdpBaseUrl()).toThrow(CavendishError);
    expect(() => resolveCdpBaseUrl()).toThrow(/CDP endpoint not found/);
  });

  it('throws with category "cdp_unavailable"', async () => {
    mockFsForEndpoint(false);
    mockOutputHandler();

    const { resolveCdpBaseUrl } = await import('../src/core/browser-manager.js');
    const { CavendishError } = await import('../src/core/errors.js');

    try {
      resolveCdpBaseUrl();
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CavendishError);
      expect((error as InstanceType<typeof CavendishError>).category).toBe('cdp_unavailable');
    }
  });

  it('throws when endpoint file has invalid port', async () => {
    mockFsForEndpoint(true, JSON.stringify({ port: -1, savedAt: '2025-01-01T00:00:00Z' }));
    mockOutputHandler();

    const { resolveCdpBaseUrl } = await import('../src/core/browser-manager.js');
    expect(() => resolveCdpBaseUrl()).toThrow(/CDP endpoint not found/);
  });
});

/* ================================================================
 * #136 — launch() kills orphan Chrome on CDP failure
 * ================================================================ */

interface MinimalBrowser {
  contexts: () => { pages: () => never[] }[];
  close: () => Promise<void>;
}

/** Mock child_process.spawn to return a fake Chrome process. */
function mockSpawn(pid: number): void {
  vi.doMock('node:child_process', () => ({
    execFileSync: (): string => '',
    spawn: (): { pid: number; unref: () => void; once: (evt: string, cb: () => void) => void } => ({
      pid,
      unref: (): void => { /* noop stub */ },
      once: (evt: string, cb: () => void): void => {
        if (evt === 'spawn') {
          queueMicrotask(cb);
        }
      },
    }),
  }));
}

/**
 * Mock node:fs for launch() tests (DevToolsActivePort file + endpoint file).
 * @param endpointPid - PID stored in the endpoint file. When set,
 *   `readCdpEndpoint()` returns an endpoint with this PID so we can
 *   test the PID-matching logic in `removeStaleCdpEndpoint`.
 */
function mockFsForLaunch(endpointPid?: number): void {
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...real,
      mkdirSync: (): undefined => undefined,
      chmodSync: (): undefined => undefined,
      existsSync: (): boolean => true,
      readFileSync: (filePath: string): string => {
        // Return endpoint JSON when reading cdp-endpoint.json
        if (typeof filePath === 'string' && filePath.includes('cdp-endpoint')) {
          if (endpointPid !== undefined) {
            return JSON.stringify({ port: 54321, pid: endpointPid, savedAt: '2025-01-01T00:00:00Z' });
          }
          // No endpoint PID configured — simulate missing/unreadable file
          throw new Error('ENOENT');
        }
        // Default: DevToolsActivePort content
        return '54321\n/devtools/browser/fake-id';
      },
      writeFileSync: (): undefined => undefined,
      unlinkSync: (path: string): undefined => {
        unlinkSyncCalls.push(path);
        return undefined;
      },
    };
  });
}

/**
 * Stub process.kill to record calls without sending real signals.
 * @param killOverride - Custom kill implementation (e.g. to throw ESRCH).
 */
function stubProcessKill(killOverride?: (pid: number, signal?: NodeJS.Signals | number) => true): void {
  vi.stubGlobal('process', {
    ...process,
    kill: killOverride ?? ((killPid: number, signal?: NodeJS.Signals | number): true => {
      processKillCalls.push({ pid: killPid, signal });
      return true;
    }),
  });
}

/**
 * Import BrowserManager with mocked dependencies.
 * `fetchBehavior` controls the CDP probe response.
 * `connectBehavior` controls whether connectOverCDP succeeds or fails.
 */
async function importWithMocks(options: {
  fetchBehavior: (url: string, init?: RequestInit) => Promise<Response>;
  connectBehavior?: 'success' | 'fail';
  spawnPid?: number;
  endpointPid?: number;
  killOverride?: (pid: number, signal?: NodeJS.Signals | number) => true;
}): Promise<{ BrowserManager: typeof import('../src/core/browser-manager.js').BrowserManager }> {
  vi.resetModules();

  const pid = options.spawnPid ?? 12345;
  const connectFails = options.connectBehavior === 'fail';

  mockSpawn(pid);
  mockFsForLaunch(options.endpointPid);
  mockOutputHandler();

  const stubBrowser: MinimalBrowser = {
    contexts: (): { pages: () => never[] }[] => [{ pages: (): never[] => [] }],
    close: (): Promise<void> => Promise.resolve(),
  };

  vi.doMock('playwright-core', () => ({
    chromium: {
      connectOverCDP: (): Promise<MinimalBrowser> => {
        if (connectFails) {
          return Promise.reject(new Error('connectOverCDP failed'));
        }
        return Promise.resolve(stubBrowser);
      },
    },
  }));

  vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
    return options.fetchBehavior(url, init);
  });

  stubProcessKill(options.killOverride);

  const mod = await import('../src/core/browser-manager.js');
  return { BrowserManager: mod.BrowserManager };
}

describe('launch() kills orphan Chrome on CDP failure (#136)', () => {
  it('kills the Chrome process when CDP discovery times out', async () => {
    vi.useFakeTimers();

    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.reject(new TypeError('fetch failed')),
      spawnPid: 99999,
    });

    const bm = new BrowserManager();

    const [result] = await Promise.allSettled([
      bm.launch(true),
      vi.runAllTimersAsync(),
    ]);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect((result.reason as Error).message).toMatch(/did not start a CDP endpoint/);
    }

    // Verify process.kill was called with the Chrome PID
    expect(processKillCalls.some((c) => c.pid === 99999)).toBe(true);
    // No endpoint file was saved (discovery failed), so nothing to unlink
    expect(unlinkSyncCalls.length).toBe(0);

    vi.useRealTimers();
  });

  it('kills the Chrome process and removes stale endpoint when connectOverCDP fails', async () => {
    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
      connectBehavior: 'fail',
      spawnPid: 88888,
      endpointPid: 88888, // endpoint belongs to the same process
    });

    const bm = new BrowserManager();

    // Raw connectOverCDP error is wrapped in CavendishError
    await expect(bm.launch(true)).rejects.toThrow(/Failed to connect to Chrome via CDP/);

    // Verify process.kill was called with the Chrome PID
    expect(processKillCalls.some((c) => c.pid === 88888)).toBe(true);
    // Verify stale endpoint file is removed so subsequent commands
    // don't try to connect to the dead port
    expect(unlinkSyncCalls.length).toBeGreaterThan(0);
  });

  it('wraps connectOverCDP errors in CavendishError with cdp_unavailable category', async () => {
    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
      connectBehavior: 'fail',
      spawnPid: 44444,
      endpointPid: 44444,
    });
    const { CavendishError } = await import('../src/core/errors.js');

    const bm = new BrowserManager();

    try {
      await bm.launch(true);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CavendishError);
      expect((error as InstanceType<typeof CavendishError>).category).toBe('cdp_unavailable');
      expect((error as InstanceType<typeof CavendishError>).message).toContain('connectOverCDP failed');
    }
  });

  it('does not remove endpoint when it belongs to a different Chrome process', async () => {
    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
      connectBehavior: 'fail',
      spawnPid: 88888,
      endpointPid: 11111, // endpoint belongs to a DIFFERENT process
    });

    const bm = new BrowserManager();

    // Raw connectOverCDP error is wrapped in CavendishError
    await expect(bm.launch(true)).rejects.toThrow(/Failed to connect to Chrome via CDP/);

    // Chrome should still be killed
    expect(processKillCalls.some((c) => c.pid === 88888)).toBe(true);
    // But endpoint file should NOT be removed — it belongs to PID 11111.
    // The read-then-delete approach sees a PID mismatch and leaves the file.
    expect(unlinkSyncCalls.length).toBe(0);
  });

  it('does not kill Chrome or remove endpoint when launch succeeds', async () => {
    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
      connectBehavior: 'success',
      spawnPid: 77777,
    });

    const bm = new BrowserManager();
    await bm.launch(true);

    // process.kill should NOT have been called with the Chrome PID
    expect(processKillCalls.some((c) => c.pid === 77777)).toBe(false);
    // Endpoint file should NOT be removed on success
    expect(unlinkSyncCalls.length).toBe(0);
  });

  it('removes endpoint when process already exited (ESRCH) and PID matches', async () => {
    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
      connectBehavior: 'fail',
      spawnPid: 66666,
      endpointPid: 66666,
      killOverride: (): true => {
        const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      },
    });

    const bm = new BrowserManager();

    // Should throw the wrapped CavendishError, not ESRCH
    await expect(bm.launch(true)).rejects.toThrow(/Failed to connect to Chrome via CDP/);
    // ESRCH means process already exited — endpoint should still be cleaned up
    expect(unlinkSyncCalls.length).toBeGreaterThan(0);
  });

  it('does not remove endpoint when kill fails with EPERM', async () => {
    const { BrowserManager } = await importWithMocks({
      fetchBehavior: (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
      connectBehavior: 'fail',
      spawnPid: 55555,
      endpointPid: 55555,
      killOverride: (): true => {
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      },
    });

    const bm = new BrowserManager();

    await expect(bm.launch(true)).rejects.toThrow(/Failed to connect to Chrome via CDP/);
    // EPERM means Chrome is likely still running — do NOT remove endpoint
    expect(unlinkSyncCalls.length).toBe(0);
  });
});
