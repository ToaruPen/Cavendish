import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { JobNotificationPayload, JobRecord } from './types.js';

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[cavendish:jobs] failed to parse notification source "${path}": ${message}\n`,
    );
    return undefined;
  }
}

function readStoredResultContent(path: string): string | undefined {
  const parsed = readJsonFile(path);
  const event = parsed?.event;
  if (typeof event !== 'object' || event === null) {
    return undefined;
  }
  const resultEvent = event as { content?: unknown };
  return typeof resultEvent.content === 'string' ? resultEvent.content : undefined;
}

function readStoredErrorMessage(path: string): string | undefined {
  const parsed = readJsonFile(path);
  return typeof parsed?.message === 'string' ? parsed.message : undefined;
}

export function notifyJobCompletion(record: JobRecord): void {
  if (record.notifyFile === undefined) {
    return;
  }
  try {
    mkdirSync(dirname(record.notifyFile), { recursive: true });
    const payload: JobNotificationPayload = {
      jobId: record.jobId,
      kind: record.kind,
      status: record.status,
      resultPath: record.resultPath,
      errorPath: record.errorPath,
      chatId: record.chatId,
      url: record.url,
      partial: record.partial,
      finalResponse: readStoredResultContent(record.resultPath),
      errorMessage: readStoredErrorMessage(record.errorPath) ?? record.error?.message,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(record.notifyFile, `${JSON.stringify(payload)}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[cavendish:jobs] completion notification write failed: ${record.notifyFile} (${message})\n`,
    );
  }
}
