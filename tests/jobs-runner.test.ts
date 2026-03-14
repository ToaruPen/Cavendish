import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testRoot: string;
let spawnMock: ReturnType<typeof vi.fn>;

function makeChild(
  stdoutLines: string[],
  stderrLines: string[],
  exitCode: number,
): EventEmitter & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    for (const line of stdoutLines) {
      child.stdout.write(`${line}\n`);
    }
    child.stdout.end();
    for (const line of stderrLines) {
      child.stderr.write(`${line}\n`);
    }
    child.stderr.end();
    child.emit('close', exitCode);
  });
  return child;
}

async function importWithMocks(
  spawnImpl: () => ReturnType<typeof makeChild>,
): Promise<{
  runner: typeof import('../src/core/jobs/runner.js');
  store: typeof import('../src/core/jobs/store.js');
}> {
  vi.resetModules();
  vi.doMock('node:os', async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...realOs,
      homedir: (): string => testRoot,
    };
  });
  vi.doMock('node:child_process', () => {
    spawnMock = vi.fn(() => spawnImpl());
    return {
      spawn: spawnMock,
    };
  });
  const runner = await import('../src/core/jobs/runner.js');
  const store = await import('../src/core/jobs/store.js');
  return { runner, store };
}

describe('job runner', () => {
  beforeEach(() => {
    testRoot = join(process.cwd(), `.tmp-job-runner-${randomUUID()}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('runs queued jobs sequentially in submission order', async () => {
    let attempt = 0;
    const firstFinalLine = JSON.stringify({
      type: 'final',
      content: 'first',
      timestamp: '2026-03-14T00:00:00.000Z',
      partial: false,
    });
    const secondFinalLine = JSON.stringify({
      type: 'final',
      content: 'second',
      timestamp: '2026-03-14T00:00:01.000Z',
      partial: false,
    });
    const { runner, store } = await importWithMocks(() => {
      attempt += 1;
      return attempt === 1
        ? makeChild([firstFinalLine], [], 0)
        : makeChild([secondFinalLine], [], 0);
    });
    const firstJob = store.createJob({
      kind: 'ask',
      argv: ['ask', 'first'],
    });
    const secondJob = store.createJob({
      kind: 'ask',
      argv: ['ask', 'second'],
    });
    store.updateJob(firstJob.jobId, {
      submittedAt: '2026-03-14T00:00:00.000Z',
    });
    store.updateJob(secondJob.jobId, {
      submittedAt: '2026-03-14T00:00:01.000Z',
    });

    await runner.runJobRunner();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      'ask',
      'first',
      '--stream',
      '--format',
      'json',
      '--quiet',
    ]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      expect.any(String),
      'ask',
      'second',
      '--stream',
      '--format',
      'json',
      '--quiet',
    ]);
    expect(store.readJob(firstJob.jobId)?.status).toBe('completed');
    expect(store.readJob(secondJob.jobId)?.status).toBe('completed');
  });

  it('retries queued jobs when the global process lock is busy', async () => {
    const lockError = JSON.stringify({
      error: true,
      category: 'cdp_unavailable',
      message: 'Another cavendish process (PID: 1) is running. Wait for it to finish or kill it manually.',
      exitCode: 2,
      action: 'wait',
    });
    const finalLine = JSON.stringify({
      type: 'final',
      content: 'done after retry',
      timestamp: '2026-03-14T00:00:00.000Z',
      partial: false,
    });
    let attempts = 0;
    const { runner, store } = await importWithMocks(() => {
      attempts += 1;
      if (attempts === 1) {
        return makeChild([], [lockError], 2);
      }
      return makeChild([finalLine], [], 0);
    });
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });

    await runner.runJobRunner();

    expect(attempts).toBe(2);
    expect(store.readJob(job.jobId)?.status).toBe('completed');
  });

  it('fails a job after repeated lock-contention retries', async () => {
    const lockError = JSON.stringify({
      error: true,
      category: 'cdp_unavailable',
      message: 'Another cavendish process (PID: 1) is running. Wait for it to finish or kill it manually.',
      exitCode: 2,
      action: 'wait',
    });
    let attempts = 0;
    const { runner, store } = await importWithMocks(() => {
      attempts += 1;
      return makeChild([], [lockError], 2);
    });
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });

    await runner.runJobRunner();

    expect(attempts).toBe(3);
    expect(store.readJob(job.jobId)?.status).toBe('failed');
    expect(store.readJob(job.jobId)?.retryCount).toBe(3);
    expect(store.readJobError(job.jobId)?.message).toContain('Another cavendish process');
  });

  it('fails fast when the runner lock file is corrupt', async () => {
    const { runner } = await importWithMocks(() => makeChild([], [], 0));
    const cavendishDir = join(testRoot, '.cavendish');
    mkdirSync(cavendishDir, { recursive: true });
    writeFileSync(join(cavendishDir, 'jobs-runner.lock'), 'not-a-pid\n');

    await expect(runner.runJobRunner()).rejects.toThrow(/corrupt/);
  });
});
