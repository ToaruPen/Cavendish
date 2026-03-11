import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the process lock mechanism (acquireLock / releaseLock).
 *
 * We mock `node:os` homedir() so that CAVENDISH_DIR resolves to a
 * temp directory, keeping tests isolated from the real filesystem.
 */

let testRoot: string;
let fakeCavendishDir: string;
let fakeLockFile: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `cavendish-lock-test-${randomUUID()}`);
  fakeCavendishDir = join(testRoot, '.cavendish');
  mkdirSync(fakeCavendishDir, { recursive: true });
  fakeLockFile = join(fakeCavendishDir, 'cavendish.lock');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(testRoot, { recursive: true, force: true });
});

/**
 * Dynamically import process-lock with homedir() pointing to testRoot.
 */
async function importWithMockedHome(): Promise<{
  acquireLock: () => void;
  releaseLock: () => void;
  LOCK_FILE_PATH: string;
}> {
  vi.resetModules();

  vi.doMock('node:os', async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...realOs,
      homedir: (): string => testRoot,
    };
  });

  const mod = await import('../src/core/process-lock.js');
  return {
    acquireLock: mod.acquireLock,
    releaseLock: mod.releaseLock,
    LOCK_FILE_PATH: mod.LOCK_FILE_PATH,
  };
}

describe('acquireLock', () => {
  it('creates lock file with current PID', async () => {
    const { acquireLock } = await importWithMockedHome();

    acquireLock();

    expect(existsSync(fakeLockFile)).toBe(true);
    const content = readFileSync(fakeLockFile, 'utf8').trim();
    expect(content).toBe(String(process.pid));
  });

  it('throws when another live process holds the lock', async () => {
    const { acquireLock } = await importWithMockedHome();

    // Write a lock file with PID 1 (init/launchd — always alive)
    writeFileSync(fakeLockFile, '1', { flag: 'wx' });

    expect(() => {
      acquireLock();
    }).toThrow(/Another cavendish process \(PID: 1\) is running/);
  });

  it('recovers from stale lock (dead process)', async () => {
    const { acquireLock } = await importWithMockedHome();

    // Use a PID that is very unlikely to be alive (max PID value)
    const deadPid = 2147483647;
    writeFileSync(fakeLockFile, String(deadPid), { flag: 'wx' });

    // Should not throw — stale lock is removed and re-acquired
    acquireLock();

    expect(existsSync(fakeLockFile)).toBe(true);
    const content = readFileSync(fakeLockFile, 'utf8').trim();
    expect(content).toBe(String(process.pid));
  });

  it('recovers from lock file with invalid content', async () => {
    const { acquireLock } = await importWithMockedHome();

    // Write garbage to the lock file
    writeFileSync(fakeLockFile, 'not-a-pid', { flag: 'wx' });

    // Should not throw — invalid PID is treated as a stale lock
    acquireLock();

    expect(existsSync(fakeLockFile)).toBe(true);
    const content = readFileSync(fakeLockFile, 'utf8').trim();
    expect(content).toBe(String(process.pid));
  });

  it('throws CavendishError with cdp_unavailable category', async () => {
    const { acquireLock } = await importWithMockedHome();
    const { CavendishError } = await import('../src/core/errors.js');

    // PID 1 is always alive
    writeFileSync(fakeLockFile, '1', { flag: 'wx' });

    try {
      acquireLock();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CavendishError);
      expect((err as InstanceType<typeof CavendishError>).category).toBe('cdp_unavailable');
    }
  });
});

describe('releaseLock', () => {
  it('removes lock file owned by current process', async () => {
    const { acquireLock, releaseLock } = await importWithMockedHome();

    acquireLock();
    expect(existsSync(fakeLockFile)).toBe(true);

    releaseLock();
    expect(existsSync(fakeLockFile)).toBe(false);
  });

  it('does not remove lock file owned by another process', async () => {
    const { releaseLock } = await importWithMockedHome();

    // Write a lock file with a different PID
    writeFileSync(fakeLockFile, '1');

    releaseLock();

    // Lock file should still exist (not our PID)
    expect(existsSync(fakeLockFile)).toBe(true);
  });

  it('is a no-op when no lock file exists', async () => {
    const { releaseLock } = await importWithMockedHome();

    // Should not throw — verify the directory is still intact
    expect(existsSync(fakeLockFile)).toBe(false);
    releaseLock();
    expect(existsSync(fakeLockFile)).toBe(false);
  });
});

describe('LOCK_FILE_PATH', () => {
  it('resolves to ~/.cavendish/cavendish.lock', async () => {
    const { LOCK_FILE_PATH } = await importWithMockedHome();

    expect(LOCK_FILE_PATH).toBe(fakeLockFile);
  });
});
