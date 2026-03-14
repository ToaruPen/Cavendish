import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testRoot: string;

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
  store: typeof import('../src/core/jobs/store.js');
  worker: typeof import('../src/core/jobs/worker.js');
}> {
  vi.resetModules();
  vi.doMock('node:os', async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...realOs,
      homedir: (): string => testRoot,
    };
  });
  vi.doMock('node:child_process', () => ({
    spawn: vi.fn(() => spawnImpl()),
  }));
  const store = await import('../src/core/jobs/store.js');
  const worker = await import('../src/core/jobs/worker.js');
  return { store, worker };
}

describe('job worker', () => {
  beforeEach(() => {
    testRoot = join(process.cwd(), `.tmp-job-worker-${randomUUID()}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('marks a job completed and writes a notification', async () => {
    const finalLine = JSON.stringify({
      type: 'final',
      content: 'done',
      timestamp: '2026-03-14T00:00:00.000Z',
      partial: false,
      chatId: 'chat-1',
      url: 'https://chatgpt.com/c/chat-1',
    });
    const { store, worker } = await importWithMocks(() => makeChild([finalLine], [], 0));
    const notifyFile = join(testRoot, 'notify.ndjson');
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
      notifyFile,
    });

    await worker.runJobWorker(job.jobId);

    expect(store.readJob(job.jobId)?.status).toBe('completed');
    expect(store.readJobResult(job.jobId)?.event.content).toBe('done');
    expect(readFileSync(notifyFile, 'utf8')).toContain('"jobId"');
  });

  it('retries queued jobs when the process lock is busy', async () => {
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
    const { store, worker } = await importWithMocks(() => {
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

    await worker.runJobWorker(job.jobId);

    expect(attempts).toBe(2);
    expect(store.readJob(job.jobId)?.status).toBe('completed');
    expect(readFileSync(store.getJobEventsPath(job.jobId), 'utf8')).toContain('"job-queued"');
  });

  it('marks a timed out job as timed_out when the child exits without a final event', async () => {
    const errorLine = JSON.stringify({
      error: true,
      category: 'timeout',
      message: 'timed out',
      exitCode: 7,
      action: 'retry',
    });
    const { store, worker } = await importWithMocks(() => makeChild([], [errorLine], 7));
    const job = store.createJob({
      kind: 'deep-research',
      argv: ['deep-research', 'topic'],
    });

    await worker.runJobWorker(job.jobId);

    expect(store.readJob(job.jobId)?.status).toBe('timed_out');
    expect(store.readJobError(job.jobId)?.category).toBe('timeout');
  });
});
