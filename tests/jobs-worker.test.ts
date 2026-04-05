import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testRoot: string;

function makeChild(
  stdoutLines: string[],
  stderrLines: string[],
  exitCode: number,
): EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } {
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
  spawnMock: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.doMock('node:os', async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...realOs,
      homedir: (): string => testRoot,
    };
  });
  const spawnMock = vi.fn(() => spawnImpl());
  vi.doMock('node:child_process', () => ({
    spawn: spawnMock,
  }));
  const store = await import('../src/core/jobs/store.js');
  const worker = await import('../src/core/jobs/worker.js');
  return { store, worker, spawnMock };
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

    const result = await worker.runJobWorker(job.jobId);

    expect(result.outcome).toBe('completed');
    expect(store.readJob(job.jobId)?.status).toBe('completed');
    expect(store.readJobResult(job.jobId)?.event.content).toBe('done');
    expect(readFileSync(notifyFile, 'utf8')).toContain('"jobId"');
  });

  it('returns a retry outcome when the process lock is busy', async () => {
    const lockError = JSON.stringify({
      error: true,
      category: 'cdp_unavailable',
      message: 'Another cavendish process (PID: 1) is running. Wait for it to finish or kill it manually.',
      exitCode: 2,
      action: 'wait',
    });
    const { store, worker } = await importWithMocks(() => makeChild([], [lockError], 2));
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });

    const result = await worker.runJobWorker(job.jobId);

    expect(result.outcome).toBe('retry');
    expect(result.record?.retryCount).toBe(1);
    expect(store.readJob(job.jobId)?.status).toBe('queued');
    expect(store.readJob(job.jobId)?.startedAt).toBeUndefined();
    expect(store.readJob(job.jobId)?.retryCount).toBe(1);
    expect(store.readJob(job.jobId)?.lastRetriedAt).toBeDefined();
    expect(store.readJob(job.jobId)?.lastRetryError).toContain('Another cavendish process');
    expect(store.readJobResult(job.jobId)).toBeUndefined();
    expect(store.readJobError(job.jobId)).toBeUndefined();
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

    const result = await worker.runJobWorker(job.jobId);

    expect(result.outcome).toBe('timed_out');
    expect(store.readJob(job.jobId)?.status).toBe('timed_out');
    expect(store.readJobError(job.jobId)?.category).toBe('timeout');
  });

  it('recovers partial content from chunk events when no final event is emitted', async () => {
    const chunk1 = JSON.stringify({ type: 'chunk', content: 'Hello', timestamp: '2026-01-01T00:00:00Z' });
    const chunk2 = JSON.stringify({ type: 'chunk', content: 'Hello world', timestamp: '2026-01-01T00:00:01Z' });
    const chunk3 = JSON.stringify({ type: 'chunk', content: 'Hello world, this is partial', timestamp: '2026-01-01T00:00:02Z' });
    const errorLine = JSON.stringify({
      error: true,
      category: 'timeout',
      message: 'Response stalled',
      exitCode: 7,
      action: 'retry',
    });
    const { store, worker } = await importWithMocks(() => makeChild(
      [chunk1, chunk2, chunk3],
      [errorLine],
      7,
    ));
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });

    const result = await worker.runJobWorker(job.jobId);

    expect(result.outcome).toBe('timed_out');
    const savedResult = store.readJobResult(job.jobId);
    expect(savedResult).toBeDefined();
    expect(savedResult?.event.content).toBe('Hello world, this is partial');
    expect(savedResult?.event.partial).toBe(true);
    // JobRecord.partial must match result.json for notification consistency
    expect(store.readJob(job.jobId)?.partial).toBe(true);
  });

  it('propagates a non-zero exit code for failed worker runs', async () => {
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
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await worker.runJobWorkerOrExit(job.jobId);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('uses the structured lock-contention exit code for retry outcomes', async () => {
    const lockError = JSON.stringify({
      error: true,
      category: 'cdp_unavailable',
      message: 'Another cavendish process (PID: 1) is running. Wait for it to finish or kill it manually.',
      exitCode: 2,
      action: 'wait',
    });
    const { store, worker } = await importWithMocks(() => makeChild([], [lockError], 2));
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await worker.runJobWorkerOrExit(job.jobId);
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('treats a missing final event with exit code 0 as a failure', async () => {
    const { store, worker } = await importWithMocks(() => makeChild([], [], 0));
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await worker.runJobWorkerOrExit(job.jobId);
      expect(store.readJobError(job.jobId)?.exitCode).toBe(1);
      expect(store.readJob(job.jobId)?.exitCode).toBe(1);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('normalizes zero structured error exit codes for failed worker runs', async () => {
    const errorLine = JSON.stringify({
      error: true,
      category: 'timeout',
      message: 'timed out',
      exitCode: 0,
      action: 'retry',
    });
    const { store, worker } = await importWithMocks(() => makeChild([], [errorLine], 0));
    const job = store.createJob({
      kind: 'deep-research',
      argv: ['deep-research', 'topic'],
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await worker.runJobWorkerOrExit(job.jobId);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('records fallback errors even when job metadata becomes unreadable', async () => {
    const { store, worker } = await importWithMocks(() => makeChild([], [], 0));
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    writeFileSync(store.getJobFilePath(job.jobId), 'null\n');

    expect(() => {
      worker.markUnexpectedJobFailure(job.jobId, new Error('boom'));
    }).not.toThrow();
    expect(store.readJobError(job.jobId)?.message).toBe('boom');
  });

  it('pipes prompt file content to child stdin instead of argv (#178)', async () => {
    const finalLine = JSON.stringify({
      type: 'final',
      content: 'done',
      timestamp: '2026-03-14T00:00:00.000Z',
      partial: false,
    });
    let capturedStdinData = '';
    const { store, worker, spawnMock } = await importWithMocks(() => {
      const child = makeChild([finalLine], [], 0);
      child.stdin.on('data', (chunk: Buffer) => {
        capturedStdinData += chunk.toString();
      });
      return child;
    });
    const job = store.createJob({
      kind: 'ask',
      argv: ['ask', '--model', 'Pro', '--timeout', '120'],
      prompt: 'my prompt from file',
    });

    await worker.runJobWorker(job.jobId);

    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).toBeDefined();
    if (spawnArgs === undefined) {
      throw new Error('spawn was not called');
    }
    // Prompt must NOT appear in argv (avoids ps exposure and ARG_MAX)
    expect(spawnArgs).not.toContain('my prompt from file');
    expect(spawnArgs).not.toContain('--');
    // Worker flags must be appended
    expect(spawnArgs).toContain('--stream');
    expect(spawnArgs).toContain('--format');
    expect(spawnArgs).toContain('--quiet');
    // Prompt must be piped via stdin from the prompt file
    expect(capturedStdinData).toBe('my prompt from file');
  });
});
