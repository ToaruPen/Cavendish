import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for ensureProfileDirectories() — verifies that
 * ~/.cavendish/ and chrome-profile are created/hardened to 0o700.
 *
 * We mock `node:os` homedir() to point at a temp directory so the
 * real ensureProfileDirectories function runs against a sandbox.
 */

/* ---------- temp directory helpers ---------- */

let testRoot: string;
let fakeCavendishDir: string;
let fakeChromeProfileDir: string;

function permissionBits(dirPath: string): number {
  return statSync(dirPath).mode & 0o777;
}

beforeEach(() => {
  testRoot = join(tmpdir(), `cavendish-test-${randomUUID()}`);
  mkdirSync(testRoot, { recursive: true });
  fakeCavendishDir = join(testRoot, '.cavendish');
  fakeChromeProfileDir = join(fakeCavendishDir, 'chrome-profile');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(testRoot, { recursive: true, force: true });
});

/* ---------- import with mocked homedir ---------- */

/**
 * Dynamically import browser-manager with `homedir()` pointing to testRoot.
 * This lets the real ensureProfileDirectories run against our sandbox.
 */
async function importWithMockedHome(): Promise<{
  ensureProfileDirectories: () => void;
}> {
  vi.resetModules();

  vi.doMock('node:os', async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...realOs,
      homedir: (): string => testRoot,
    };
  });

  const mod = await import('../src/core/browser-manager.js');
  return { ensureProfileDirectories: mod.ensureProfileDirectories };
}

describe('ensureProfileDirectories', () => {
  it('creates both directories when they do not exist', async () => {
    const { ensureProfileDirectories } = await importWithMockedHome();

    ensureProfileDirectories();

    expect(existsSync(fakeCavendishDir)).toBe(true);
    expect(existsSync(fakeChromeProfileDir)).toBe(true);
  });

  // chmod is a no-op on Windows — permission assertions are guarded.
  it('sets expected permissions on newly created directories', async () => {
    const { ensureProfileDirectories } = await importWithMockedHome();

    ensureProfileDirectories();

    expect(existsSync(fakeCavendishDir)).toBe(true);
    expect(existsSync(fakeChromeProfileDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(permissionBits(fakeCavendishDir)).toBe(0o700);
      expect(permissionBits(fakeChromeProfileDir)).toBe(0o700);
    }
  });

  it('tightens permissions on pre-existing directories', async () => {
    mkdirSync(fakeChromeProfileDir, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') {
      chmodSync(fakeCavendishDir, 0o755);
      chmodSync(fakeChromeProfileDir, 0o755);
      expect(permissionBits(fakeCavendishDir)).toBe(0o755);
      expect(permissionBits(fakeChromeProfileDir)).toBe(0o755);
    }

    const { ensureProfileDirectories } = await importWithMockedHome();

    ensureProfileDirectories();

    expect(existsSync(fakeCavendishDir)).toBe(true);
    expect(existsSync(fakeChromeProfileDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(permissionBits(fakeCavendishDir)).toBe(0o700);
      expect(permissionBits(fakeChromeProfileDir)).toBe(0o700);
    }
  });

  it('is idempotent — calling twice does not error or change state', async () => {
    const { ensureProfileDirectories } = await importWithMockedHome();

    ensureProfileDirectories();
    ensureProfileDirectories();

    expect(existsSync(fakeCavendishDir)).toBe(true);
    expect(existsSync(fakeChromeProfileDir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(permissionBits(fakeCavendishDir)).toBe(0o700);
      expect(permissionBits(fakeChromeProfileDir)).toBe(0o700);
    }
  });
});
