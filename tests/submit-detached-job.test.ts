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

vi.mock('node:child_process', () => {
  unrefMock = vi.fn();
  spawnMock = vi.fn(() => ({
    once: vi.fn(),
    unref: unrefMock,
  }));
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
      const record: { jobId: string; kind: string } = submitDetachedJob({
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
      expect(() => submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
      })).toThrow('spawn failed');

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
