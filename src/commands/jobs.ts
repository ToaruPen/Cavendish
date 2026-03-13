import { defineCommand } from 'citty';

import { FORMAT_ARG, GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { CavendishError, type StructuredErrorPayload } from '../core/errors.js';
import { readJobError, readJobResult, readJob, listJobs } from '../core/jobs/store.js';
import { runJobWorkerOrExit } from '../core/jobs/worker.js';
import { fail, failStructured, jsonRaw, text, validateFormat } from '../core/output-handler.js';

const JOBS_ARGS = {
  ...GLOBAL_ARGS,
  ...FORMAT_ARG,
};

const JOB_ID_ARGS = {
  jobId: {
    type: 'positional' as const,
    description: 'Detached job ID',
    required: true as const,
  },
  ...GLOBAL_ARGS,
  ...FORMAT_ARG,
};

const RUN_WORKER_ARGS = {
  jobId: {
    type: 'positional' as const,
    description: 'Detached job ID',
    required: true as const,
  },
};

function formatJobText(jobId: string, kind: string, status: string): string {
  return `${jobId}\t${kind}\t${status}`;
}

function outputJobs(format: 'json' | 'text'): void {
  const jobs = listJobs().map((job) => ({
    id: job.jobId,
    kind: job.kind,
    status: job.status,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    chatId: job.chatId,
  }));
  if (format === 'json') {
    jsonRaw(jobs);
    return;
  }
  for (const job of jobs) {
    text(formatJobText(job.id, job.kind, job.status));
  }
}

function throwStoredError(error: StructuredErrorPayload): never {
  throw new CavendishError(error.message, error.category, error.action);
}

async function waitForTerminalJob(jobId: string, timeoutMs: number): Promise<Exclude<ReturnType<typeof readJob>, undefined>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readJob(jobId);
    if (job === undefined) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'timed_out' || job.status === 'cancelled') {
      return job;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List detached jobs',
  },
  args: JOBS_ARGS,
  run({ args }): void {
    const format = validateFormat(args.format);
    if (format === undefined) { return; }
    if (!rejectUnknownFlags(JOBS_ARGS, format)) { return; }
    outputJobs(format);
  },
});

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show detached job status',
  },
  args: JOB_ID_ARGS,
  run({ args }): void {
    const format = validateFormat(args.format);
    if (format === undefined) { return; }
    if (!rejectUnknownFlags(JOB_ID_ARGS, format)) { return; }
    const job = readJob(args.jobId);
    if (job === undefined) {
      fail(`Job not found: ${args.jobId}`);
      return;
    }
    if (format === 'json') {
      jsonRaw(job);
      return;
    }
    text(formatJobText(job.jobId, job.kind, job.status));
  },
});

const waitCommand = defineCommand({
  meta: {
    name: 'wait',
    description: 'Wait for a detached job to finish',
  },
  args: {
    ...JOB_ID_ARGS,
    timeout: {
      type: 'string' as const,
      description: 'Maximum wait time in seconds (default: 3600)',
      default: '3600',
    },
  },
  async run({ args }): Promise<void> {
    const format = validateFormat(args.format);
    if (format === undefined) { return; }
    if (!rejectUnknownFlags({
      ...JOB_ID_ARGS,
      timeout: { type: 'string' as const },
    }, format)) { return; }
    const timeoutSec = Number(args.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      fail(`--timeout must be a positive number, got "${args.timeout}"`);
      return;
    }
    try {
      const job = await waitForTerminalJob(args.jobId, timeoutSec * 1000);
      const result = readJobResult(job.jobId);
      const error = readJobError(job.jobId) ?? job.error;
      if (job.status === 'failed' || job.status === 'cancelled' || (job.status === 'timed_out' && result === undefined)) {
        if (error !== undefined) {
          throwStoredError(error);
        }
        fail(`Job ${job.jobId} failed without structured error details`);
        return;
      }
      if (result === undefined) {
        fail(`Job ${job.jobId} completed without a saved result`);
        return;
      }
      if (format === 'json') {
        jsonRaw({
          content: result.event.content,
          model: result.event.model,
          chatId: result.event.chatId,
          url: result.event.url,
          project: result.event.project,
          partial: result.event.partial ?? false,
          timeoutSec: result.event.timeoutSec,
          timestamp: result.event.timestamp,
        });
      } else {
        text(result.event.content);
      }
    } catch (error: unknown) {
      failStructured(error, format);
    }
  },
});

const runWorkerCommand = defineCommand({
  meta: {
    name: 'run-worker',
    description: 'Run a detached job worker',
  },
  args: RUN_WORKER_ARGS,
  async run({ args }): Promise<void> {
    await runJobWorkerOrExit(args.jobId);
  },
});

export const jobsCommand = defineCommand({
  meta: {
    name: 'jobs',
    description: 'Inspect and wait for detached jobs',
  },
  args: JOBS_ARGS,
  subCommands: {
    list: listCommand,
    status: statusCommand,
    wait: waitCommand,
    'run-worker': runWorkerCommand,
  },
  run({ args }): void {
    const format = validateFormat(args.format);
    if (format === undefined) { return; }
    if (!rejectUnknownFlags(JOBS_ARGS, format)) { return; }
    outputJobs(format);
  },
});
