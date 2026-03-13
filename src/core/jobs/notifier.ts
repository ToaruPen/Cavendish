import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { JobNotificationPayload, JobRecord } from './types.js';

export function notifyJobCompletion(record: JobRecord): void {
  if (record.notifyFile === undefined) {
    return;
  }
  mkdirSync(dirname(record.notifyFile), { recursive: true });
  const payload: JobNotificationPayload = {
    jobId: record.jobId,
    kind: record.kind,
    status: record.status,
    resultPath: record.resultPath,
    chatId: record.chatId,
    url: record.url,
    partial: record.partial,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(record.notifyFile, `${JSON.stringify(payload)}\n`);
}
