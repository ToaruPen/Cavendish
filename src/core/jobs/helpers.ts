import { resolve } from 'node:path';

import { jsonRaw, failValidation, text } from '../output-handler.js';

export interface DetachedSubmitPayload {
  jobId: string;
  status: string;
  kind: string;
  submittedAt: string;
  jobPath: string;
  eventsPath: string;
  chatId?: string;
  notifyFile?: string;
}

export function validateDetachedOptions(
  args: Record<string, unknown>,
  format: 'json' | 'text',
  stream: boolean,
): { detach: boolean; notifyFile: string | undefined } | undefined {
  const detach = args.detach === true;
  if (stream && detach) {
    failValidation('--stream cannot be used with --detach', format);
    return undefined;
  }
  const notifyFile = typeof args.notifyFile === 'string' && args.notifyFile.length > 0
    ? resolve(args.notifyFile)
    : undefined;
  if (args.notifyFile !== undefined && notifyFile === undefined) {
    failValidation('--notify-file cannot be empty. Use: --notify-file <path>', format);
    return undefined;
  }
  return { detach, notifyFile };
}

export function writeDetachedSubmit(
  payload: DetachedSubmitPayload,
  format: 'json' | 'text',
): void {
  if (format === 'text') {
    const lines = [
      `jobId: ${payload.jobId}`,
      `kind: ${payload.kind}`,
      `status: ${payload.status}`,
      `jobPath: ${payload.jobPath}`,
      `eventsPath: ${payload.eventsPath}`,
    ];
    if (payload.chatId !== undefined) {
      lines.push(`chatId: ${payload.chatId}`);
    }
    if (payload.notifyFile !== undefined) {
      lines.push(`notifyFile: ${payload.notifyFile}`);
    }
    text(lines.join('\n'));
    return;
  }
  jsonRaw(payload);
}
