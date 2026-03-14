import type { StructuredErrorPayload } from '../errors.js';
import type { NdjsonEvent } from '../output-handler.js';

export type JobKind = 'ask' | 'deep-research';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface DetachedJobRequest {
  kind: JobKind;
  argv: string[];
  prompt?: string;
  notifyFile?: string;
}

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  argv: string[];
  notifyFile?: string;
  submittedAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  chatId?: string;
  url?: string;
  partial?: boolean;
  exitCode?: number;
  retryCount: number;
  lastRetriedAt?: string;
  lastRetryError?: string;
  resultPath: string;
  eventsPath: string;
  errorPath: string;
  error?: StructuredErrorPayload;
}

export interface JobResultRecord {
  event: NdjsonEvent;
  savedAt: string;
}

export interface JobNotificationPayload {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  resultPath: string;
  errorPath: string;
  chatId?: string;
  url?: string;
  partial?: boolean;
  finalResponse?: string;
  errorMessage?: string;
  timestamp: string;
}
