import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLI_ENTRY = '/Users/sankenbisha/Dev/cavendish/dist/index.mjs';
const NOTIFY_FILE = '/Users/sankenbisha/Dev/cavendish/.tmp-tests/notify.ndjson';

let spawnMock: ReturnType<typeof vi.fn>;
let createJobMock: ReturnType<typeof vi.fn>;
let unrefMock: ReturnType<typeof vi.fn>;
let updateJobMock: ReturnType<typeof vi.fn>;
let writeJobErrorMock: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', () => {
  unrefMock = vi.fn();
  spawnMock = vi.fn(() => ({
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
  });

  it('creates a job record and spawns a detached worker', async () => {
    const previousArgv1 = process.argv[1];
    process.argv[1] = CLI_ENTRY;
    try {
      const { submitDetachedJob } = await import('../src/core/jobs/submit.js');
      const record: { jobId: string; kind: string } = submitDetachedJob({
        kind: 'ask',
        argv: ['ask', 'hello'],
        notifyFile: NOTIFY_FILE,
      });

      expect(createJobMock).toHaveBeenCalledWith({
        kind: 'ask',
        argv: ['ask', 'hello'],
        notifyFile: NOTIFY_FILE,
      });
      const spawnCalls = spawnMock.mock.calls as [
        [string, string[], { detached: boolean; stdio: string; env: Record<string, string | undefined> }],
      ];
      expect(spawnCalls[0][0]).toBe(process.execPath);
      expect(spawnCalls[0][1]).toEqual([CLI_ENTRY, 'jobs', 'run-worker', 'job-123']);
      expect(spawnCalls[0][2].detached).toBe(true);
      expect(spawnCalls[0][2].stdio).toBe('ignore');
      expect(spawnCalls[0][2].env.CAVENDISH_JOB_WORKER).toBe('1');
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

  it('marks the job failed when worker spawn throws', async () => {
    const previousArgv1 = process.argv[1];
    process.argv[1] = CLI_ENTRY;
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
