import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOTIFY_FILE = '/Users/sankenbisha/Dev/cavendish/.tmp-tests/notify.ndjson';

let spawnMock: ReturnType<typeof vi.fn>;
let createJobMock: ReturnType<typeof vi.fn>;
let unrefMock: ReturnType<typeof vi.fn>;
let updateJobMock: ReturnType<typeof vi.fn>;
let writeJobErrorMock: ReturnType<typeof vi.fn>;
let testRoot: string;
let cliEntry: string;

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
  updateJobMock = vi.fn();
  writeJobErrorMock = vi.fn();
  createJobMock = vi.fn(() => ({
    jobId: 'job-123',
    kind: 'ask',
    status: 'queued',
  }));
  return {
    createJob: createJobMock,
    updateJob: updateJobMock,
    writeJobError: writeJobErrorMock,
  };
});

describe('submitDetachedJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(updateJobMock).toHaveBeenCalledWith('job-123', expect.objectContaining({
        status: 'failed',
        exitCode: 1,
      }));
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
    try {
      const { submitDetachedJob } = await import('../src/core/jobs/submit.js');

      const record = await submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
      });

      expect(record.jobId).toBe('job-123');
      expect(writeJobErrorMock).toHaveBeenCalledOnce();
      expect(updateJobMock).toHaveBeenCalledWith('job-123', expect.objectContaining({
        status: 'failed',
        exitCode: 1,
      }));
    } finally {
      process.argv[1] = previousArgv1;
    }
  });
});
