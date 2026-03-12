import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for init --reset recovery when cdp-endpoint.json is missing (#146).
 *
 * When the CDP endpoint file is absent, killExistingChrome should:
 * - Scan for Chrome processes by profile directory (via pgrep/wmic)
 * - Kill found processes instead of throwing
 * - Proceed gracefully when no Chrome processes are found
 */

/* ---------- shared state ---------- */

let processKillCalls: { pid: number; signal: NodeJS.Signals | number | undefined }[];

beforeEach(() => {
  processKillCalls = [];
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
    errorMessage: (e: unknown): string => (e instanceof Error ? e.message : String(e)),
    failStructured: (): undefined => undefined,
    jsonRaw: (): undefined => undefined,
    text: (): undefined => undefined,
    validateFormat: (): string => 'text',
  }));
}

/**
 * Mock node:fs so that existsSync returns true for the process scanner
 * binary (e.g. /usr/bin/pgrep, /bin/pgrep, or powershell.exe) and the
 * rest delegates to the real fs.
 */
function mockFsForProcessScanner(): void {
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...real,
      // Return true for the scanner binary so resolveProcessScanner() succeeds
      existsSync: (path: string): boolean => {
        if (path === '/usr/bin/pgrep' || path === '/bin/pgrep' || path === '/sbin/pgrep' || path.includes('powershell')) {
          return true;
        }
        return real.existsSync(path);
      },
    };
  });
}

/**
 * Mock node:fs so that existsSync returns false for the process scanner
 * binary, simulating a system without pgrep/powershell.
 */
function mockFsNoScanner(): void {
  vi.doMock('node:fs', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...real,
      existsSync: (path: string): boolean => {
        if (path === '/usr/bin/pgrep' || path === '/bin/pgrep' || path === '/sbin/pgrep' || path.includes('powershell')) {
          return false;
        }
        return real.existsSync(path);
      },
    };
  });
}

/**
 * Stub process.kill to record calls without sending real signals.
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

/* ================================================================
 * findChromeByProfileDir — process scanning tests
 * ================================================================ */

describe('findChromeByProfileDir — scans for Chrome by profile dir (#146)', () => {
  it('returns PIDs when pgrep finds matching processes', async () => {
    mockFsForProcessScanner();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_cmd: string, _args: string[]): string => '12345\n67890\n',
    }));
    mockOutputHandler();

    const { findChromeByProfileDir } = await import('../src/commands/init.js');
    const pids = findChromeByProfileDir();
    expect(pids).toEqual([12345, 67890]);
  });

  it('passes "--" to pgrep so --user-data-dir is treated as a pattern, not an option', async () => {
    mockFsForProcessScanner();
    let capturedArgs: string[] = [];
    vi.doMock('node:child_process', () => ({
      execFileSync: (_cmd: string, args: string[]): string => {
        capturedArgs = args;
        return '';
      },
    }));
    mockOutputHandler();

    const { findChromeByProfileDir } = await import('../src/commands/init.js');
    findChromeByProfileDir();
    // pgrep must receive "--" before the pattern to prevent
    // "--user-data-dir=..." being parsed as an illegal option.
    expect(capturedArgs).toContain('--');
    const dashDashIndex = capturedArgs.indexOf('--');
    const patternIndex = capturedArgs.findIndex((a) => a.includes('--user-data-dir='));
    expect(dashDashIndex).toBeLessThan(patternIndex);
  });

  it('returns empty array when pgrep finds no matches (exit code 1)', async () => {
    mockFsForProcessScanner();
    vi.doMock('node:child_process', () => ({
      execFileSync: (): string => {
        // pgrep exits with code 1 when no processes match
        const err = new Error('Command failed with exit code 1') as Error & { status: number };
        err.status = 1;
        throw err;
      },
    }));
    mockOutputHandler();

    const { findChromeByProfileDir } = await import('../src/commands/init.js');
    const pids = findChromeByProfileDir();
    expect(pids).toEqual([]);
  });

  it('returns null when scanner encounters a non-exit-1 error', async () => {
    mockFsForProcessScanner();
    vi.doMock('node:child_process', () => ({
      execFileSync: (): string => {
        // Unexpected error (e.g. timeout, spawn failure)
        const err = new Error('Command timed out') as Error & { status: number };
        err.status = 2;
        throw err;
      },
    }));
    mockOutputHandler();

    const { findChromeByProfileDir } = await import('../src/commands/init.js');
    const result = findChromeByProfileDir();
    expect(result).toBeNull();
  });

  it('returns null when scanner binary is not found', async () => {
    mockFsNoScanner();
    vi.doMock('node:child_process', () => ({
      execFileSync: (): string => '',
    }));
    mockOutputHandler();

    const { findChromeByProfileDir } = await import('../src/commands/init.js');
    const result = findChromeByProfileDir();
    expect(result).toBeNull();
  });

  it('filters out invalid lines from pgrep output', async () => {
    mockFsForProcessScanner();
    vi.doMock('node:child_process', () => ({
      execFileSync: (): string => '12345\n\nnot-a-number\n67890\n',
    }));
    mockOutputHandler();

    const { findChromeByProfileDir } = await import('../src/commands/init.js');
    const pids = findChromeByProfileDir();
    expect(pids).toEqual([12345, 67890]);
  });
});

/* ================================================================
 * killChromePids — process killing tests
 * ================================================================ */

describe('killChromePids — kills Chrome processes by PID (#146)', () => {
  it('sends SIGTERM to each PID and returns true', async () => {
    mockOutputHandler();
    stubProcessKill();

    const { killChromePids } = await import('../src/commands/init.js');
    const result = killChromePids([111, 222], true);

    expect(result).toBe(true);
    expect(processKillCalls).toEqual([
      { pid: 111, signal: 'SIGTERM' },
      { pid: 222, signal: 'SIGTERM' },
    ]);
  });

  it('returns true when process already exited (ESRCH)', async () => {
    mockOutputHandler();
    stubProcessKill((): true => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const { killChromePids } = await import('../src/commands/init.js');
    const result = killChromePids([333], true);
    expect(result).toBe(true);
  });

  it('returns false when kill fails with EPERM and no process succeeds', async () => {
    mockOutputHandler();
    stubProcessKill((): true => {
      const err = new Error('kill EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const { killChromePids } = await import('../src/commands/init.js');
    const result = killChromePids([444], true);
    expect(result).toBe(false);
  });

  it('returns true when at least one process is killed despite EPERM on another', async () => {
    mockOutputHandler();
    let callCount = 0;
    stubProcessKill((pid: number): true => {
      callCount += 1;
      if (callCount === 1) {
        // First call fails with EPERM
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      processKillCalls.push({ pid, signal: 'SIGTERM' });
      return true;
    });

    const { killChromePids } = await import('../src/commands/init.js');
    const result = killChromePids([555, 666], true);
    expect(result).toBe(true);
    expect(processKillCalls.some((c) => c.pid === 666)).toBe(true);
  });

  it('returns false for empty PID array', async () => {
    mockOutputHandler();
    stubProcessKill();

    const { killChromePids } = await import('../src/commands/init.js');
    const result = killChromePids([], true);
    expect(result).toBe(false);
    expect(processKillCalls.length).toBe(0);
  });
});

/* ================================================================
 * waitForPidExit — polling + SIGKILL escalation tests
 * ================================================================ */

describe('waitForPidExit — polls until PIDs exit with SIGKILL escalation (#146)', () => {
  it('resolves immediately when all PIDs are already gone (ESRCH)', async () => {
    mockOutputHandler();
    stubProcessKill((_pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0) {
        const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    const { waitForPidExit } = await import('../src/commands/init.js');
    // Should resolve without throwing
    await expect(waitForPidExit([111, 222], 1_000)).resolves.toBeUndefined();
  });

  it('resolves when PIDs exit during polling', async () => {
    mockOutputHandler();
    let pollCount = 0;
    stubProcessKill((_pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0) {
        pollCount += 1;
        if (pollCount >= 3) {
          // After a few polls, process is gone
          const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        // Process still alive
        return true;
      }
      return true;
    });

    const { waitForPidExit } = await import('../src/commands/init.js');
    await expect(waitForPidExit([999], 5_000)).resolves.toBeUndefined();
  });

  it('throws CavendishError when PIDs survive timeout and SIGKILL (EPERM)', async () => {
    mockOutputHandler();
    stubProcessKill((_pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0) {
        // EPERM: process is alive but owned by another user
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      if (signal === 'SIGKILL') {
        // EPERM: cannot kill process owned by another user
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    const { waitForPidExit } = await import('../src/commands/init.js');
    // Use a very short timeout so the test runs quickly
    await expect(waitForPidExit([777], 100)).rejects.toThrow(
      'Chrome process(es) did not exit in time: 777',
    );
  });

  it('does not treat EPERM as process exit during polling', async () => {
    mockOutputHandler();
    const killSignals: (NodeJS.Signals | number | undefined)[] = [];
    stubProcessKill((_pid: number, signal?: NodeJS.Signals | number): true => {
      killSignals.push(signal);
      if (signal === 0) {
        // EPERM: process alive but owned by another user
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      if (signal === 'SIGKILL') {
        // SIGKILL also fails with EPERM
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    const { waitForPidExit } = await import('../src/commands/init.js');
    await expect(waitForPidExit([888], 100)).rejects.toThrow('Chrome process(es) did not exit in time');
    // Verify that SIGKILL escalation was attempted
    expect(killSignals).toContain('SIGKILL');
  });

  it('resolves when SIGKILL succeeds after timeout', async () => {
    mockOutputHandler();
    let sigkillSent = false;
    stubProcessKill((_pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 'SIGKILL') {
        sigkillSent = true;
        return true;
      }
      if (signal === 0) {
        if (sigkillSent) {
          // After SIGKILL + 500ms wait, process is gone
          const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        // During polling: EPERM (process alive but unresponsive to SIGTERM)
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    const { waitForPidExit } = await import('../src/commands/init.js');
    // Short timeout to trigger SIGKILL escalation quickly
    await expect(waitForPidExit([555], 100)).resolves.toBeUndefined();
  });
});
