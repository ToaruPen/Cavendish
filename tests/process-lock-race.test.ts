import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Race-resistance regression tests for `tryClaimStaleLock`.  Uses the
 * `_tryClaimStaleLockForTests` export to drive two simulated claimers
 * with distinct pids in a single process.
 */

const STALE_PID = 999_999_999;
const DEAD_GATE_PID = 999_999_998;

let testRoot: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `cavendish-lock-race-test-${randomUUID()}`);
  mkdirSync(join(testRoot, '.cavendish'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(testRoot, { recursive: true, force: true });
});

async function importWithMockedHome(): Promise<{
  tryClaim: (stalePid: number | null, currentPid: number) => boolean;
  LOCK_FILE_PATH: string;
  LOCK_REPLACEMENT_GATE_PATH: string;
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
    tryClaim: mod._tryClaimStaleLockForTests,
    LOCK_FILE_PATH: mod.LOCK_FILE_PATH,
    LOCK_REPLACEMENT_GATE_PATH: mod.LOCK_REPLACEMENT_GATE_PATH,
  };
}

function writeStaleLock(lockFilePath: string, pid: number = STALE_PID): void {
  writeFileSync(lockFilePath, String(pid), { flag: 'wx' });
}

describe('tryClaimStaleLock — race resistance', () => {
  it('a second claim with the same stale-pid expectation fails after the first succeeds', async () => {
    const { tryClaim, LOCK_FILE_PATH } = await importWithMockedHome();
    writeStaleLock(LOCK_FILE_PATH);

    expect(tryClaim(STALE_PID, 100)).toBe(true);
    expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe('100');

    // Process B captured the same stale pid before A claimed and now
    // races to claim.  The lock now actually holds A's pid, so B must
    // refuse to overwrite it.
    expect(tryClaim(STALE_PID, 200)).toBe(false);
    expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe('100');
  });

  it('returns false when the lock has already been recreated by a third party', async () => {
    const { tryClaim, LOCK_FILE_PATH } = await importWithMockedHome();
    writeFileSync(LOCK_FILE_PATH, '12345', { flag: 'wx' });

    expect(tryClaim(STALE_PID, 100)).toBe(false);
    expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe('12345');
  });

  it('returns false when the lock file has been removed entirely', async () => {
    const { tryClaim, LOCK_FILE_PATH } = await importWithMockedHome();
    expect(existsSync(LOCK_FILE_PATH)).toBe(false);
    expect(tryClaim(STALE_PID, 100)).toBe(false);
  });

  it('releases the replacement gate on success so the next claim can proceed', async () => {
    const { tryClaim, LOCK_FILE_PATH, LOCK_REPLACEMENT_GATE_PATH } = await importWithMockedHome();
    writeStaleLock(LOCK_FILE_PATH);

    expect(tryClaim(STALE_PID, 100)).toBe(true);
    expect(existsSync(LOCK_REPLACEMENT_GATE_PATH)).toBe(false);
  });

  it('releases the replacement gate even when a stale-pid mismatch causes early exit', async () => {
    const { tryClaim, LOCK_FILE_PATH, LOCK_REPLACEMENT_GATE_PATH } = await importWithMockedHome();
    writeFileSync(LOCK_FILE_PATH, '12345', { flag: 'wx' });

    expect(tryClaim(STALE_PID, 100)).toBe(false);
    expect(existsSync(LOCK_REPLACEMENT_GATE_PATH)).toBe(false);
    expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe('12345');
  });

  it('a second claim sees the gate held by a live process and bails out without overwriting', async () => {
    const { tryClaim, LOCK_FILE_PATH, LOCK_REPLACEMENT_GATE_PATH } = await importWithMockedHome();
    writeStaleLock(LOCK_FILE_PATH);
    // The gate's holder pid is the test runner itself — guaranteed alive.
    writeFileSync(LOCK_REPLACEMENT_GATE_PATH, String(process.pid), { flag: 'wx' });
    try {
      expect(tryClaim(STALE_PID, 200)).toBe(false);
      expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe(String(STALE_PID));
      expect(readFileSync(LOCK_REPLACEMENT_GATE_PATH, 'utf8').trim()).toBe(String(process.pid));
    } finally {
      rmSync(LOCK_REPLACEMENT_GATE_PATH, { force: true });
    }
  });

  it('reclaims a replacement gate abandoned by a dead holder', async () => {
    const { tryClaim, LOCK_FILE_PATH, LOCK_REPLACEMENT_GATE_PATH } = await importWithMockedHome();
    writeStaleLock(LOCK_FILE_PATH);
    writeFileSync(LOCK_REPLACEMENT_GATE_PATH, String(DEAD_GATE_PID), { flag: 'wx' });

    expect(tryClaim(STALE_PID, 100)).toBe(true);
    expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe('100');
    expect(existsSync(LOCK_REPLACEMENT_GATE_PATH)).toBe(false);
  });

  it('reclaims a replacement gate whose holder pid file is corrupt', async () => {
    const { tryClaim, LOCK_FILE_PATH, LOCK_REPLACEMENT_GATE_PATH } = await importWithMockedHome();
    writeStaleLock(LOCK_FILE_PATH);
    writeFileSync(LOCK_REPLACEMENT_GATE_PATH, 'not-a-pid', { flag: 'wx' });

    expect(tryClaim(STALE_PID, 100)).toBe(true);
    expect(readFileSync(LOCK_FILE_PATH, 'utf8').trim()).toBe('100');
    expect(existsSync(LOCK_REPLACEMENT_GATE_PATH)).toBe(false);
  });
});
