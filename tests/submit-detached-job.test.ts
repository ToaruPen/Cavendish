import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StructuredErrorPayload } from '../src/core/errors.js';

const NOTIFY_FILE = join(process.cwd(), '.tmp-tests', 'notify.ndjson');
const SUBMIT_RESULT_PATH = join(process.cwd(), '.tmp-tests', 'submit-result.json');
const SUBMIT_EVENTS_PATH = join(process.cwd(), '.tmp-tests', 'submit-events.ndjson');
const SUBMIT_ERROR_PATH = join(process.cwd(), '.tmp-tests', 'submit-error.json');

let spawnMock: ReturnType<typeof vi.fn>;
let createJobMock: ReturnType<typeof vi.fn>;
let readJobMock: ReturnType<typeof vi.fn>;
let unrefMock: ReturnType<typeof vi.fn>;
let updateJobMock: ReturnType<typeof vi.fn>;
let writeJobErrorMock: ReturnType<typeof vi.fn>;
let testRoot: string;
let cliEntry: string;
let spawnedChild: ReturnType<typeof makeSpawnChild> | undefined;

interface FailedJobUpdate {
  status?: string;
  exitCode?: number;
  error?: StructuredErrorPayload;
}

function makeSpawnChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = unrefMock;
  queueMicrotask(() => {
    child.emit('spawn');
  });
  return child;
}

vi.mock('node:child_process', () => {
  unrefMock = vi.fn();
  spawnMock = vi.fn(() => makeSpawnChild());
  return {
    spawn: spawnMock,
  };
});

vi.mock('../src/core/jobs/store.js', () => {
  readJobMock = vi.fn(() => ({
    jobId: 'job-123',
    kind: 'ask',
    status: 'queued',
    argv: [],
    submittedAt: '2026-03-14T00:00:00.000Z',
    updatedAt: '2026-03-14T00:00:00.000Z',
    retryCount: 0,
    resultPath: SUBMIT_RESULT_PATH,
    eventsPath: SUBMIT_EVENTS_PATH,
    errorPath: SUBMIT_ERROR_PATH,
  }));
  updateJobMock = vi.fn();
  writeJobErrorMock = vi.fn();
  createJobMock = vi.fn(() => ({
    jobId: 'job-123',
    kind: 'ask',
    status: 'queued',
  }));
  return {
    createJob: createJobMock,
    readJob: readJobMock,
    updateJob: updateJobMock,
    writeJobError: writeJobErrorMock,
  };
});

describe('submitDetachedJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnedChild = undefined;
    testRoot = mkdtempSync(join(process.cwd(), '.tmp-submit-'));
    cliEntry = join(testRoot, 'index.mjs');
    writeFileSync(cliEntry, '');
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('creates a job record and spawns a detached runner', async () => {
    const previousArgv1 = process.argv[1];
    process.argv[1] = cliEntry;
    try {
      const { submitDetachedJob } = await import('../src/core/jobs/submit.js');
      const record: { jobId: string; kind: string } = await submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
        prompt: 'hello from stdin',
        notifyFile: NOTIFY_FILE,
      });

      expect(createJobMock).toHaveBeenCalledWith({
        kind: 'ask',
        argv: ['ask', 'hello'],
        prompt: 'hello from stdin',
        notifyFile: NOTIFY_FILE,
      });
      const spawnCall = spawnMock.mock.calls[0] as
        | [string, string[], { detached: boolean; stdio: string; env: Record<string, string | undefined> }]
        | undefined;
      expect(spawnCall).toBeDefined();
      if (spawnCall === undefined) {
        throw new Error('Detached runner spawn call was not captured');
      }
      expect(spawnCall[0]).toBe(process.execPath);
      expect(spawnCall[1]).toEqual([cliEntry, 'jobs', 'run-runner']);
      expect(spawnCall[2].detached).toBe(true);
      expect(spawnCall[2].stdio).toBe('ignore');
      expect(spawnCall[2].env).toBeUndefined();
      expect(unrefMock).toHaveBeenCalledOnce();
      expect(record).toMatchObject({
        jobId: 'job-123',
        kind: 'ask',
      });
      expect(updateJobMock).not.toHaveBeenCalled();
      expect(writeJobErrorMock).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = previousArgv1;
    }
  });

  it('marks the job failed when runner spawn throws', async () => {
    const previousArgv1 = process.argv[1];
    process.argv[1] = cliEntry;
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    try {
      const { submitDetachedJob } = await import('../src/core/jobs/submit.js');
      await expect(submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
      })).rejects.toThrow('spawn failed');

      expect(writeJobErrorMock).toHaveBeenCalledOnce();
      const writeCall = writeJobErrorMock.mock.calls[0] as [string, StructuredErrorPayload] | undefined;
      expect(writeCall?.[0]).toBe('job-123');
      expect(writeCall?.[1]).toMatchObject({
        error: true,
        category: 'unknown',
        message: 'spawn failed',
        exitCode: 1,
        action: 'Fix the detached runner launch failure and retry the command.',
      });
      const updateCall = updateJobMock.mock.calls[0] as [string, FailedJobUpdate] | undefined;
      expect(updateCall?.[0]).toBe('job-123');
      expect(updateCall?.[1].status).toBe('failed');
      expect(updateCall?.[1].exitCode).toBe(1);
      expect(updateCall?.[1].error).toMatchObject({
        category: 'unknown',
        message: 'spawn failed',
        exitCode: 1,
        action: 'Fix the detached runner launch failure and retry the command.',
      });
    } finally {
      process.argv[1] = previousArgv1;
    }
  });

  it('marks the job failed when the detached runner exits non-zero immediately after spawn', async () => {
    const previousArgv1 = process.argv[1];
    process.argv[1] = cliEntry;
    spawnMock.mockImplementationOnce(() => {
      const child = makeSpawnChild();
      queueMicrotask(() => {
        child.emit('exit', 1, null);
      });
      return child;
    });
    readJobMock.mockReturnValueOnce({
      jobId: 'job-123',
      kind: 'ask',
      status: 'failed',
      exitCode: 1,
      error: {
        error: true,
        category: 'unknown',
        message: 'Detached runner exited during startup (code: 1, signal: null)',
        exitCode: 1,
        action: 'Fix the detached runner launch failure and retry the command.',
      },
      argv: [],
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
      retryCount: 0,
      resultPath: SUBMIT_RESULT_PATH,
      eventsPath: SUBMIT_EVENTS_PATH,
      errorPath: SUBMIT_ERROR_PATH,
    });
    try {
      const { submitDetachedJob } = await import('../src/core/jobs/submit.js');

      const record = await submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
      });

      expect(record).toMatchObject({
        jobId: 'job-123',
        status: 'failed',
        exitCode: 1,
      });
      expect(record.error?.category).toBe('unknown');
      expect(record.error?.exitCode).toBe(1);
      expect(record.error?.action).toBe('Fix the detached runner launch failure and retry the command.');
      expect(record.error?.message).toContain('Detached runner exited during startup');
      expect(writeJobErrorMock).toHaveBeenCalledOnce();
      const writeCall = writeJobErrorMock.mock.calls[0] as [string, StructuredErrorPayload] | undefined;
      expect(writeCall?.[0]).toBe('job-123');
      expect(writeCall?.[1]).toMatchObject({
        error: true,
        category: 'unknown',
        exitCode: 1,
        action: 'Fix the detached runner launch failure and retry the command.',
      });
      expect(writeCall?.[1].message).toContain('Detached runner exited during startup');
      const updateCall = updateJobMock.mock.calls[0] as [string, FailedJobUpdate] | undefined;
      expect(updateCall?.[0]).toBe('job-123');
      expect(updateCall?.[1].status).toBe('failed');
      expect(updateCall?.[1].exitCode).toBe(1);
      expect(updateCall?.[1].error).toMatchObject({
        category: 'unknown',
        exitCode: 1,
        action: 'Fix the detached runner launch failure and retry the command.',
      });
      expect(updateCall?.[1].error?.message).toContain('Detached runner exited during startup');
      expect(readJobMock).toHaveBeenCalledWith('job-123');
    } finally {
      process.argv[1] = previousArgv1;
    }
  });

  it('stops observing runner exits after the startup window', async () => {
    vi.useFakeTimers();
    const previousArgv1 = process.argv[1];
    process.argv[1] = cliEntry;
    spawnMock.mockImplementationOnce(() => {
      spawnedChild = makeSpawnChild();
      return spawnedChild;
    });
    try {
      const { submitDetachedJob } = await import('../src/core/jobs/submit.js');
      const submitPromise = submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
      });
      await vi.advanceTimersByTimeAsync(501);
      await submitPromise;

      if (spawnedChild === undefined) {
        throw new Error('Expected detached child process to be captured');
      }
      spawnedChild.emit('exit', 1, null);

      expect(writeJobErrorMock).not.toHaveBeenCalled();
      expect(updateJobMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      process.argv[1] = previousArgv1;
    }
  });
});
