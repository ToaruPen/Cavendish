import { beforeEach, describe, expect, it, vi } from 'vitest';

let failStructuredMock: ReturnType<typeof vi.fn>;
let jsonRawMock: ReturnType<typeof vi.fn>;
let progressMock: ReturnType<typeof vi.fn>;

interface RunnableCommand {
  run?: (context: {
    args: never;
    rawArgs: string[];
    cmd: RunnableCommand;
  }) => void | Promise<void>;
}

vi.mock('../src/core/cli-args.js', () => ({
  FORMAT_ARG: {},
  GLOBAL_ARGS: {},
  rejectUnknownFlags: vi.fn().mockReturnValue(true),
  toTimeoutMs: (sec: number): number => sec === 0 ? Number.MAX_SAFE_INTEGER : sec * 1000,
  formatTimeoutDisplay: (sec: number): string => sec === 0 ? 'unlimited' : `${String(sec)}s`,
}));

vi.mock('../src/core/jobs/store.js', () => ({
  getJobEventsPath: vi.fn((jobId: string) => `/tmp/cavendish-test-events-${jobId}.ndjson`),
  listJobs: vi.fn(() => [
    {
      jobId: 'job-1',
      kind: 'ask',
      status: 'queued',
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
      retryCount: 2,
      lastRetriedAt: '2026-03-14T00:00:10.000Z',
      lastRetryError: 'Another cavendish process is running.',
    },
  ]),
  readJob: vi.fn(),
  readJobError: vi.fn(),
  readJobResult: vi.fn(),
}));

vi.mock('../src/core/jobs/worker.js', () => ({
  runJobWorkerOrExit: vi.fn(),
}));

vi.mock('../src/core/jobs/runner.js', () => ({
  runJobRunnerOrExit: vi.fn(),
}));

vi.mock('../src/core/output-handler.js', () => {
  failStructuredMock = vi.fn();
  jsonRawMock = vi.fn();
  progressMock = vi.fn();
  return {
    fail: vi.fn(),
    failStructured: failStructuredMock,
    jsonRaw: jsonRawMock,
    progress: progressMock,
    text: vi.fn(),
    validateFormat: vi.fn().mockReturnValue('json'),
  };
});

describe('jobs command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists detached jobs from the root jobs command', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: [],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).toHaveBeenCalledWith([
      {
        id: 'job-1',
        kind: 'ask',
        status: 'queued',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:00.000Z',
        chatId: undefined,
        retryCount: 2,
        lastRetriedAt: '2026-03-14T00:00:10.000Z',
        lastRetryError: 'Another cavendish process is running.',
      },
    ]);
  });

  it('does not emit the root jobs list when a subcommand is invoked', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: ['read'],
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: ['read', 'job-1', '--format', 'json'],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).not.toHaveBeenCalled();
  });

  it('does not emit the root jobs list when options appear before a subcommand', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: ['read'],
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: ['--format', 'json', 'read', 'job-1'],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).not.toHaveBeenCalled();
  });

  it('does not treat string option values as subcommand names', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        format: 'list',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: ['--format', 'list'],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces invalid job metadata through failStructured', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const store = await import('../src/core/jobs/store.js');
    vi.mocked(store.readJob).mockImplementation(() => {
      throw new Error('Job job-1 has invalid status metadata. Recreate the detached job and retry.');
    });
    const subCommands = jobsCommand.subCommands as unknown as { read?: RunnableCommand };
    const readCommand = subCommands.read;
    const run = readCommand?.run;
    if (readCommand === undefined || run === undefined) {
      throw new Error('jobsCommand.subCommands.read.run is undefined');
    }

    await Promise.resolve(run({
      args: {
        _: [],
        jobId: 'job-1',
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: [],
      cmd: readCommand,
    }));

    expect(failStructuredMock).toHaveBeenCalledTimes(1);
  });

  it('supports --poll on jobs wait and emits periodic progress updates', async () => {
    vi.useFakeTimers();
    try {
      const { jobsCommand } = await import('../src/commands/jobs.js');
      const store = await import('../src/core/jobs/store.js');
      const runningJob = {
        jobId: 'job-1',
        kind: 'ask',
        status: 'running',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:00.000Z',
        retryCount: 0,
      } as never;
      const completedJob = {
        jobId: 'job-1',
        kind: 'ask',
        status: 'completed',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:02.000Z',
        retryCount: 0,
      } as never;
      // Return running for many iterations, then completed after ~2.2s
      // (each loop iteration sleeps 200ms, so 11 iterations ≈ 2.2s)
      const readJobMock = vi.mocked(store.readJob);
      for (let i = 0; i < 11; i++) {
        readJobMock.mockReturnValueOnce(runningJob);
      }
      readJobMock.mockReturnValue(completedJob);

      vi.mocked(store.readJobResult).mockReturnValue({
        event: {
          content: 'final response',
          model: 'Pro',
          partial: false,
          timeoutSec: 0,
          timestamp: '2026-03-14T00:00:02.000Z',
        },
      } as never);

      const subCommands = jobsCommand.subCommands as unknown as {
        wait?: RunnableCommand;
      };
      const waitCommand = subCommands.wait;
      const run = waitCommand?.run;
      if (waitCommand === undefined || run === undefined) {
        throw new Error('jobsCommand.subCommands.wait.run is undefined');
      }

      const runPromise = Promise.resolve(run({
        args: {
          _: [],
          jobId: 'job-1',
          poll: '1',
          timeout: '10',
          format: 'json',
          quiet: false,
          verbose: false,
        } as never,
        rawArgs: [],
        cmd: waitCommand,
      }));

      // Initial progress fires immediately (nextProgressAt = Date.now()),
      // then every pollIntervalMs (1000ms). At T=1100: 2 calls (T=0 + T=1000).
      await vi.advanceTimersByTimeAsync(1100);
      expect(progressMock).toHaveBeenCalledTimes(2);
      expect(progressMock).toHaveBeenCalledWith(
        expect.stringContaining('status: running'),
        false,
      );

      // Advance past next poll boundary (T=2000ms) — third progress call
      await vi.advanceTimersByTimeAsync(1100);
      expect(progressMock).toHaveBeenCalledTimes(3);

      // Job completes after ~2.2s
      await runPromise;

      expect(jsonRawMock).toHaveBeenCalledWith({
        jobId: 'job-1',
        status: 'completed',
        content: 'final response',
        model: 'Pro',
        chatId: undefined,
        url: undefined,
        project: undefined,
        partial: false,
        timeoutSec: 0,
        timestamp: '2026-03-14T00:00:02.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes jobId and status in wait JSON output for timed_out jobs', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const store = await import('../src/core/jobs/store.js');
    vi.mocked(store.readJob).mockReturnValue({
      jobId: 'job-2',
      kind: 'ask',
      status: 'timed_out',
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:01:00.000Z',
      retryCount: 0,
      partial: true,
    } as never);
    vi.mocked(store.readJobResult).mockReturnValue({
      event: {
        type: 'final',
        content: 'partial response text',
        model: 'Pro',
        partial: true,
        timeoutSec: 600,
        timestamp: '2026-03-14T00:01:00.000Z',
      },
    } as never);
    vi.mocked(store.readJobError).mockReturnValue(undefined);

    const subCommands = jobsCommand.subCommands as unknown as {
      wait?: RunnableCommand;
    };
    const waitCommand = subCommands.wait;
    const run = waitCommand?.run;
    if (waitCommand === undefined || run === undefined) {
      throw new Error('jobsCommand.subCommands.wait.run is undefined');
    }

    await run({
      args: {
        _: [],
        jobId: 'job-2',
        timeout: '5',
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: [],
      cmd: waitCommand,
    });

    expect(jsonRawMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-2',
        status: 'timed_out',
        content: 'partial response text',
        partial: true,
      }),
    );
  });

  it('fails jobs wait with a no-progress error when a running job has stale updatedAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T00:06:00.000Z'));
    try {
      const { jobsCommand } = await import('../src/commands/jobs.js');
      const store = await import('../src/core/jobs/store.js');
      vi.mocked(store.readJob).mockReturnValue({
        jobId: 'job-stalled',
        kind: 'ask',
        status: 'running',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:00.000Z',
        retryCount: 0,
      } as never);

      const subCommands = jobsCommand.subCommands as unknown as {
        wait?: RunnableCommand;
      };
      const waitCommand = subCommands.wait;
      const run = waitCommand?.run;
      if (waitCommand === undefined || run === undefined) {
        throw new Error('jobsCommand.subCommands.wait.run is undefined');
      }

      await run({
        args: {
          _: [],
          jobId: 'job-stalled',
          poll: '1',
          timeout: undefined,
          format: 'json',
          quiet: false,
          verbose: false,
        } as never,
        rawArgs: [],
        cmd: waitCommand,
      });

      expect(progressMock).toHaveBeenCalledWith(
        expect.stringContaining('no progress'),
        false,
      );
      expect(failStructuredMock).toHaveBeenCalledTimes(1);
      const firstCall = failStructuredMock.mock.calls[0] as unknown as [
        { category?: string; message?: string },
        string,
      ];
      expect(firstCall[0].category).toBe('job_no_progress');
      expect(firstCall[0].message).toContain('no progress');
      expect(firstCall[1]).toBe('json');
      expect(jsonRawMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail jobs wait for an alive worker even when updatedAt is old', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T00:06:00.000Z'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const { jobsCommand } = await import('../src/commands/jobs.js');
      const store = await import('../src/core/jobs/store.js');
      const runningJob = {
        jobId: 'job-live',
        kind: 'deep-research',
        status: 'running',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:00.000Z',
        retryCount: 0,
        workerPid: 12345,
      } as never;
      const completedJob = {
        jobId: 'job-live',
        kind: 'deep-research',
        status: 'completed',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:06:02.000Z',
        retryCount: 0,
        workerPid: undefined,
      } as never;
      const readJobMock = vi.mocked(store.readJob);
      for (let i = 0; i < 6; i += 1) {
        readJobMock.mockReturnValueOnce(runningJob);
      }
      readJobMock.mockReturnValue(completedJob);
      vi.mocked(store.readJobResult).mockReturnValue({
        event: {
          content: 'deep research result',
          model: 'deep-research',
          partial: false,
          timeoutSec: 0,
          timestamp: '2026-03-14T00:06:02.000Z',
        },
      } as never);

      const subCommands = jobsCommand.subCommands as unknown as {
        wait?: RunnableCommand;
      };
      const waitCommand = subCommands.wait;
      const run = waitCommand?.run;
      if (waitCommand === undefined || run === undefined) {
        throw new Error('jobsCommand.subCommands.wait.run is undefined');
      }

      const runPromise = Promise.resolve(run({
        args: {
          _: [],
          jobId: 'job-live',
          poll: '1',
          timeout: undefined,
          format: 'json',
          quiet: false,
          verbose: false,
        } as never,
        rawArgs: [],
        cmd: waitCommand,
      }));
      await vi.advanceTimersByTimeAsync(1400);
      await runPromise;

      expect(killSpy).toHaveBeenCalledWith(12345, 0);
      expect(failStructuredMock).not.toHaveBeenCalled();
      expect(jsonRawMock).toHaveBeenCalledWith(expect.objectContaining({
        jobId: 'job-live',
        status: 'completed',
        content: 'deep research result',
      }));
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails jobs wait with no-progress when an old running worker pid is dead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T00:06:00.000Z'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });
    try {
      const { jobsCommand } = await import('../src/commands/jobs.js');
      const store = await import('../src/core/jobs/store.js');
      vi.mocked(store.readJob).mockReturnValue({
        jobId: 'job-dead',
        kind: 'ask',
        status: 'running',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:00.000Z',
        retryCount: 0,
        workerPid: 54321,
      } as never);

      const subCommands = jobsCommand.subCommands as unknown as {
        wait?: RunnableCommand;
      };
      const waitCommand = subCommands.wait;
      const run = waitCommand?.run;
      if (waitCommand === undefined || run === undefined) {
        throw new Error('jobsCommand.subCommands.wait.run is undefined');
      }

      await run({
        args: {
          _: [],
          jobId: 'job-dead',
          poll: '1',
          timeout: undefined,
          format: 'json',
          quiet: false,
          verbose: false,
        } as never,
        rawArgs: [],
        cmd: waitCommand,
      });

      expect(killSpy).toHaveBeenCalledWith(54321, 0);
      expect(failStructuredMock).toHaveBeenCalledTimes(1);
      const firstCall = failStructuredMock.mock.calls[0] as unknown as [
        { category?: string; message?: string },
        string,
      ];
      expect(firstCall[0].category).toBe('job_no_progress');
      expect(firstCall[0].message).toContain('no progress');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails jobs wait with no-progress for explicit unlimited timeout when worker pid is dead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T00:06:00.000Z'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });
    try {
      const { jobsCommand } = await import('../src/commands/jobs.js');
      const store = await import('../src/core/jobs/store.js');
      vi.mocked(store.readJob)
        .mockReturnValueOnce({
          jobId: 'job-dead-explicit',
          kind: 'ask',
          status: 'running',
          submittedAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T00:00:00.000Z',
          retryCount: 0,
          workerPid: 65432,
        } as never)
        .mockReturnValue({
          jobId: 'job-dead-explicit',
          kind: 'ask',
          status: 'completed',
          submittedAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T00:06:01.000Z',
          retryCount: 0,
        } as never);
      vi.mocked(store.readJobResult).mockReturnValue({
        event: {
          content: 'should not be returned',
          partial: false,
          timestamp: '2026-03-14T00:06:01.000Z',
        },
      } as never);

      const subCommands = jobsCommand.subCommands as unknown as {
        wait?: RunnableCommand;
      };
      const waitCommand = subCommands.wait;
      const run = waitCommand?.run;
      if (waitCommand === undefined || run === undefined) {
        throw new Error('jobsCommand.subCommands.wait.run is undefined');
      }

      const runPromise = Promise.resolve(run({
        args: {
          _: [],
          jobId: 'job-dead-explicit',
          poll: '1',
          timeout: '0',
          format: 'json',
          quiet: false,
          verbose: false,
        } as never,
        rawArgs: [],
        cmd: waitCommand,
      }));
      await vi.advanceTimersByTimeAsync(250);
      await runPromise;

      expect(killSpy).toHaveBeenCalledWith(65432, 0);
      expect(failStructuredMock).toHaveBeenCalledTimes(1);
      const firstCall = failStructuredMock.mock.calls[0] as unknown as [
        { category?: string; message?: string },
        string,
      ];
      expect(firstCall[0].category).toBe('job_no_progress');
      expect(firstCall[0].message).toContain('no progress');
      expect(jsonRawMock).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
