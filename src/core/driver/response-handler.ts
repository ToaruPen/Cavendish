/**
 * Response handling: poll ChatGPT response state until a final answer is
 * complete, a stall is detected, or the overall timeout expires.
 */

import type { Page } from 'playwright-core';

import { SELECTORS } from '../../constants/selectors.js';
import type { WaitForResponseOptions, WaitForResponseResult } from '../chatgpt-types.js';
import { CavendishError } from '../errors.js';
import { progress } from '../output-handler.js';

import { DEFAULT_TIMEOUT_MS, delay, POLL_INTERVAL_MS } from './helpers.js';

const DEFAULT_SETTLE_DELAY_MS = 1_500;
const MIN_STALL_TIMEOUT_MS = 15_000;
const NO_STOP_SETTLE_DELAY_MS = 5_000;

interface ResponseSnapshot {
  text: string;
  messageCount: number;
  stopButtonVisible: boolean;
  copyButtonVisible: boolean;
}

export async function waitForResponse(
  page: Page,
  options: WaitForResponseOptions,
): Promise<WaitForResponseResult> {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    stallTimeoutMs = resolveStallTimeout(timeout),
    settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
    onChunk,
    quiet = false,
    initialMsgCount,
    label = 'Response',
  } = options;

  progress(`Waiting for ${label}...`, quiet);

  const result = await monitorResponse(
    page,
    initialMsgCount,
    timeout,
    stallTimeoutMs,
    settleDelayMs,
    quiet,
    onChunk,
  );

  if (result.completed) {
    progress(`${label} complete`, quiet);
  } else {
    progress(`${label} timed out after ${String(Math.round(timeout / 1000))}s`, quiet);
  }

  return result;
}

export async function getLastResponse(page: Page): Promise<string> {
  return page.evaluate((selector: string) => {
    const messages = document.querySelectorAll(selector);
    if (messages.length === 0) {
      return '';
    }
    const last = messages[messages.length - 1];
    return last.textContent.trim();
  }, SELECTORS.ASSISTANT_MESSAGE);
}

export async function getAssistantMessageCount(page: Page): Promise<number> {
  return page.locator(SELECTORS.ASSISTANT_MESSAGE).count();
}

function resolveStallTimeout(timeout: number): number {
  return Math.min(
    timeout,
    Math.max(MIN_STALL_TIMEOUT_MS, Math.floor(timeout / 4)),
  );
}

async function monitorResponse(
  page: Page,
  msgCountBefore: number,
  timeout: number,
  stallTimeoutMs: number,
  settleDelayMs: number,
  quiet: boolean,
  onChunk?: (text: string) => void,
): Promise<WaitForResponseResult> {
  const deadline = Date.now() + timeout;
  let lastSnapshot: ResponseSnapshot = {
    text: '',
    messageCount: msgCountBefore,
    stopButtonVisible: false,
    copyButtonVisible: false,
  };
  let started = false;
  let sawStopButton = false;
  let lastActivityAt = Date.now();
  let lastTextChangeAt: number | undefined;
  let lastEmittedText = '';

  while (Date.now() < deadline) {
    const snapshot = await getResponseSnapshot(page, msgCountBefore);
    const now = Date.now();
    sawStopButton = sawStopButton || snapshot.stopButtonVisible;
    if (hasResponseStarted(snapshot, msgCountBefore) && !started) {
      started = true;
      lastActivityAt = now;
      progress('Response started', quiet);
    }

    if (snapshotChanged(snapshot, lastSnapshot)) {
      lastActivityAt = now;
    }

    if (snapshot.text !== lastSnapshot.text) {
      lastTextChangeAt = now;
      lastEmittedText = emitChunkIfChanged(snapshot.text, lastEmittedText, onChunk);
    }

    if (isCompletedSnapshot(snapshot, started, sawStopButton, lastTextChangeAt, now, settleDelayMs)) {
      return { text: snapshot.text, completed: true };
    }

    assertNotStalled(started, snapshot.stopButtonVisible, now, lastActivityAt, stallTimeoutMs);

    lastSnapshot = snapshot;
    await delay(POLL_INTERVAL_MS);
  }

  return { text: lastSnapshot.text, completed: false };
}

async function getResponseSnapshot(
  page: Page,
  previousCount: number,
): Promise<ResponseSnapshot> {
  const stopButtonVisible = await page.locator(SELECTORS.STOP_BUTTON)
    .isVisible()
    .catch((): boolean => false);
  const messageCount = await page.locator(SELECTORS.ASSISTANT_MESSAGE).count();

  const latest = await page.evaluate(
    (
      {
        messageSelector,
        copySelector,
        offset,
      }: {
        messageSelector: string;
        copySelector: string;
        offset: number;
      },
    ) => {
      const messages = document.querySelectorAll(messageSelector);
      if (messages.length <= offset) {
        return { text: '', copyButtonVisible: false };
      }

      const target = messages[messages.length - 1];
      const text = target.textContent.trim();
      const copyButton = target.querySelector<HTMLElement>(copySelector);
      const copyButtonVisible = copyButton !== null && copyButton.getBoundingClientRect().height > 0;

      return { text, copyButtonVisible };
    },
    {
      messageSelector: SELECTORS.ASSISTANT_MESSAGE,
      copySelector: SELECTORS.COPY_BUTTON,
      offset: previousCount,
    },
  );

  return {
    text: latest.text,
    messageCount,
    stopButtonVisible,
    copyButtonVisible: latest.copyButtonVisible,
  };
}

function hasResponseStarted(
  snapshot: ResponseSnapshot,
  msgCountBefore: number,
): boolean {
  return snapshot.stopButtonVisible
    || snapshot.messageCount > msgCountBefore
    || snapshot.text.length > 0;
}

function snapshotChanged(
  current: ResponseSnapshot,
  previous: ResponseSnapshot,
): boolean {
  return current.text !== previous.text
    || current.messageCount !== previous.messageCount
    || current.stopButtonVisible !== previous.stopButtonVisible
    || current.copyButtonVisible !== previous.copyButtonVisible;
}

function emitChunkIfChanged(
  text: string,
  lastEmittedText: string,
  onChunk: ((text: string) => void) | undefined,
): string {
  if (onChunk && text.length > 0 && text !== lastEmittedText) {
    onChunk(text);
    return text;
  }
  return lastEmittedText;
}

function isCompletedSnapshot(
  snapshot: ResponseSnapshot,
  started: boolean,
  sawStopButton: boolean,
  lastTextChangeAt: number | undefined,
  now: number,
  settleDelayMs: number,
): boolean {
  if (snapshot.copyButtonVisible && snapshot.text.length > 0) {
    return true;
  }

  const requiredSettleDelay = sawStopButton
    ? settleDelayMs
    : Math.max(settleDelayMs * 4, NO_STOP_SETTLE_DELAY_MS);

  return started
    && snapshot.text.length > 0
    && !snapshot.stopButtonVisible
    && lastTextChangeAt !== undefined
    && now - lastTextChangeAt >= requiredSettleDelay;
}

function assertNotStalled(
  started: boolean,
  stopButtonVisible: boolean,
  now: number,
  lastActivityAt: number,
  stallTimeoutMs: number,
): void {
  if (!started || stopButtonVisible || now - lastActivityAt < stallTimeoutMs) {
    return;
  }

  throw new CavendishError(
    `Response stalled for ${String(Math.round(stallTimeoutMs / 1000))}s after activity started.`,
    'timeout',
    'Retry the command. If the browser still shows progress, rerun with a higher --timeout.',
  );
}
