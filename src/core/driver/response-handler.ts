/**
 * Response handling: wait for completion using stop-button as primary signal,
 * chunk polling, and response extraction.
 *
 * All functions receive a Playwright Page and operate on it directly.
 * DOM selectors are sourced from constants/selectors.ts.
 */

import type { Locator, Page } from 'playwright-core';

import { SELECTORS } from '../../constants/selectors.js';
import type { WaitForResponseOptions, WaitForResponseResult } from '../chatgpt-types.js';
import { progress } from '../output-handler.js';

import { DEFAULT_TIMEOUT_MS, delay, isTimeoutError, POLL_INTERVAL_MS } from './helpers.js';

type StopButtonResult = 'attached' | 'message' | 'timeout';

export async function waitForResponse(
  page: Page,
  options: WaitForResponseOptions,
): Promise<WaitForResponseResult> {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    onChunk,
    quiet = false,
    initialMsgCount,
    label = 'Response',
  } = options;

  progress(`Waiting for ${label}...`, quiet);

  const completed = await waitForCompletionWithChunks(
    page,
    initialMsgCount,
    timeout,
    quiet,
    onChunk,
  );

  if (completed) {
    progress(`${label} complete`, quiet);
  } else {
    progress(
      `${label} timed out after ${String(Math.round(timeout / 1000))}s — returning partial response`,
      quiet,
    );
  }

  const text = await getResponseAfter(page, initialMsgCount);
  return { text, completed };
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

// ── Private helpers ─────────────────────────────────────────

async function getResponseAfter(page: Page, previousCount: number): Promise<string> {
  return page.evaluate(
    ({ selector, offset }: { selector: string; offset: number }) => {
      const messages = document.querySelectorAll(selector);
      if (messages.length <= offset) {
        return '';
      }
      const target = messages[messages.length - 1];
      return target.textContent.trim();
    },
    { selector: SELECTORS.ASSISTANT_MESSAGE, offset: previousCount },
  );
}

async function waitForCompletionWithChunks(
  page: Page,
  msgCountBefore: number,
  timeout: number,
  quiet: boolean,
  onChunk?: (text: string) => void,
): Promise<boolean> {
  let done = false;
  const stopBtn = page.locator(SELECTORS.STOP_BUTTON);
  const deadline = Date.now() + timeout;

  const completionPromise = (async (): Promise<boolean> => {
    const phase1Ok = await waitForStopButtonAttach(
      page, stopBtn, msgCountBefore, timeout, deadline, quiet,
    );
    if (!phase1Ok) {
      return false;
    }
    return waitForStopButtonCycle(
      page, stopBtn, msgCountBefore, deadline, quiet,
    );
  })().finally((): void => {
    done = true;
  });

  if (onChunk) {
    await pollChunks(page, () => done, msgCountBefore, quiet, onChunk);
  }

  return completionPromise;
}

async function waitForStopButtonAttach(
  page: Page,
  stopBtn: Locator,
  msgCountBefore: number,
  timeout: number,
  deadline: number,
  quiet: boolean,
): Promise<boolean> {
  const result = await raceStopButtonAndMessage(
    page, stopBtn, msgCountBefore, timeout,
  );

  if (result === 'timeout') {
    progress(`Response not detected within ${String(timeout)}ms`, quiet);
    return false;
  }

  if (result === 'attached') {
    return true;
  }

  // 'message' — assistant message appeared before stop button (Pro thinking).
  // Wait for the stop button to appear; if it never does, time out.
  const remaining = Math.max(deadline - Date.now(), 0);
  if (remaining <= 0) {
    return false;
  }
  const stopOrTimeout = await awaitStopButton(stopBtn, remaining);
  if (stopOrTimeout === 'stop') {
    return true;
  }
  // timeout
  return false;
}

async function waitForStopButtonCycle(
  page: Page,
  stopBtn: Locator,
  msgCountBefore: number,
  deadline: number,
  quiet: boolean,
): Promise<boolean> {
  while (Date.now() < deadline) {
    const remaining = Math.max(deadline - Date.now(), 0);
    try {
      await stopBtn.waitFor({ state: 'detached', timeout: remaining });
    } catch (error: unknown) {
      if (!isTimeoutError(error)) {
        throw error;
      }
      return false;
    }

    const responseText = await getResponseAfter(page, msgCountBefore);
    if (responseText.length > 0) {
      return true;
    }

    progress('Waiting for response to render...', quiet);
    const nextSignal = await waitForStopButtonOrResponse(
      page, stopBtn, msgCountBefore, deadline,
    );
    if (nextSignal === 'timeout') {
      return false;
    }
    if (nextSignal === 'response') {
      return true;
    }
    // nextSignal === 'stop-button' — loop back
  }
  return false;
}

async function raceStopButtonAndMessage(
  page: Page,
  stopBtn: Locator,
  msgCountBefore: number,
  timeout: number,
): Promise<StopButtonResult> {
  const deadline = Date.now() + timeout;
  const race = { settled: false };

  const stopPromise = stopBtn
    .waitFor({ state: 'attached', timeout })
    .then((): StopButtonResult => 'attached')
    .catch((error: unknown): StopButtonResult => {
      if (isTimeoutError(error)) {
        return 'timeout';
      }
      throw error;
    });

  const messagePromise = (async (): Promise<StopButtonResult> => {
    while (!race.settled && Date.now() < deadline) {
      const count = await page
        .locator(SELECTORS.ASSISTANT_MESSAGE)
        .count();
      if (count > msgCountBefore) {
        return 'message';
      }
      await delay(POLL_INTERVAL_MS);
    }
    return 'timeout';
  })();

  try {
    return await Promise.race([stopPromise, messagePromise]);
  } finally {
    race.settled = true;
  }
}

async function waitForStopButtonOrResponse(
  page: Page,
  stopBtn: Locator,
  msgCountBefore: number,
  deadline: number,
): Promise<'stop-button' | 'response' | 'timeout'> {
  const race = { settled: false };

  const remaining = Math.max(deadline - Date.now(), 0);
  if (remaining <= 0) {
    return 'timeout';
  }

  const stopPromise = stopBtn
    .waitFor({ state: 'attached', timeout: remaining })
    .then((): 'stop-button' => 'stop-button')
    .catch((error: unknown): 'timeout' => {
      if (isTimeoutError(error)) {
        return 'timeout';
      }
      throw error;
    });

  const responsePromise = (async (): Promise<'response' | 'timeout'> => {
    while (!race.settled && Date.now() < deadline) {
      const text = await getResponseAfter(page, msgCountBefore);
      if (text.length > 0) {
        return 'response';
      }
      await delay(POLL_INTERVAL_MS);
    }
    return 'timeout';
  })();

  try {
    return await Promise.race([stopPromise, responsePromise]);
  } finally {
    race.settled = true;
  }
}

async function awaitStopButton(
  stopBtn: Locator,
  timeout: number,
): Promise<'stop' | 'timeout'> {
  return stopBtn
    .waitFor({ state: 'attached', timeout })
    .then((): 'stop' => 'stop')
    .catch((error: unknown): 'timeout' => {
      if (isTimeoutError(error)) { return 'timeout'; }
      throw error;
    });
}

async function pollChunks(
  page: Page,
  isDone: () => boolean,
  msgCountBefore: number,
  quiet: boolean,
  onChunk: (text: string) => void,
): Promise<void> {
  let lastText = '';

  while (!isDone()) {
    try {
      const currentText = await getResponseAfter(page, msgCountBefore);
      if (currentText && currentText !== lastText) {
        lastText = currentText;
        onChunk(currentText);
      }
    } catch (error: unknown) {
      progress(`Poll error (transient): ${String(error)}`, quiet);
    }

    if (!isDone()) {
      await delay(POLL_INTERVAL_MS);
    }
  }
}
