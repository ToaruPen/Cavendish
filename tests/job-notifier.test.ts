import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { notifyJobCompletion } from '../src/core/jobs/notifier.js';

describe('notifyJobCompletion', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends a completion payload to the configured notify file', () => {
    const root = mkdtempSync(join(process.cwd(), '.tmp-notify-'));
    createdDirs.push(root);
    const notifyFile = join(root, 'events', 'notify.ndjson');

    notifyJobCompletion({
      jobId: '00000000-0000-4000-8000-000000000001',
      kind: 'ask',
      status: 'completed',
      argv: ['ask', 'hello'],
      notifyFile,
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:01.000Z',
      resultPath: join(root, 'result.json'),
      eventsPath: join(root, 'events.ndjson'),
      errorPath: join(root, 'error.json'),
      chatId: 'chat-1',
      url: 'https://chatgpt.com/c/chat-1',
      partial: false,
    });

    const content = readFileSync(notifyFile, 'utf8').trim();
    const payload = JSON.parse(content) as Record<string, unknown>;
    expect(payload).toMatchObject({
      jobId: '00000000-0000-4000-8000-000000000001',
      kind: 'ask',
      status: 'completed',
      resultPath: join(root, 'result.json'),
      chatId: 'chat-1',
      url: 'https://chatgpt.com/c/chat-1',
      partial: false,
    });
    expect(typeof payload.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(String(payload.timestamp)))).toBe(false);
  });
});
