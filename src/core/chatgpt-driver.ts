import type { Page } from 'playwright';

import { SELECTORS } from '../constants/selectors.js';

import { progress } from './output-handler.js';

const DEFAULT_TIMEOUT_MS = 2_400_000;
const POLL_INTERVAL_MS = 200;

export interface WaitForResponseOptions {
  /** Timeout in milliseconds (default: 120_000). */
  timeout?: number;
  /** Called with cumulative response text as it streams in. */
  onChunk?: (text: string) => void;
  /** Suppress stderr progress messages. */
  quiet?: boolean;
  /** Assistant message count captured BEFORE sendMessage to avoid race conditions. */
  initialMsgCount: number;
}

export interface WaitForResponseResult {
  text: string;
  completed: boolean;
}

/**
 * Drives the ChatGPT Web UI via Playwright Page interactions.
 *
 * All DOM selectors are sourced from `selectors.ts`.
 */
export class ChatGPTDriver {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Open the model picker and select the given model by name.
   * No-op if `model` is undefined.
   */
  async selectModel(model: string, quiet = false): Promise<void> {
    progress(`Selecting model: ${model}`, quiet);

    await this.waitForReady();
    await this.page.locator(SELECTORS.MODEL_SELECTOR_BUTTON).click();
    await this.page.locator(SELECTORS.MODEL_MENU).waitFor({ state: 'visible' });

    const item = this.page
      .locator(SELECTORS.MODEL_MENUITEM)
      .filter({ hasText: model });

    const count = await item.count();
    if (count !== 1) {
      // Close the menu before throwing
      await this.page.keyboard.press('Escape');
      throw new Error(
        count === 0
          ? `Model "${model}" not found in model picker. Check available models in ChatGPT.`
          : `Model "${model}" matched ${String(count)} items. Please provide a more specific model name.`,
      );
    }

    await item.first().click();
    progress(`Model set to: ${model}`, quiet);
  }

  /**
   * Wait until the ChatGPT prompt textarea is visible and interactive.
   * Useful after page navigation or initial load.
   */
  async waitForReady(timeout = 30_000): Promise<void> {
    await this.page.locator(SELECTORS.PROMPT_INPUT).waitFor({
      state: 'visible',
      timeout,
    });
  }

  /**
   * Type a message into the prompt textarea and click the send button.
   */
  async sendMessage(text: string): Promise<void> {
    await this.waitForReady();
    const input = this.page.locator(SELECTORS.PROMPT_INPUT);
    await input.fill(text);
    await this.page.locator(SELECTORS.SUBMIT_BUTTON).click();
  }

  /**
   * Return the current count of assistant messages on the page.
   * Call this BEFORE sendMessage to capture the baseline for race-free response reading.
   */
  async getAssistantMessageCount(): Promise<number> {
    return this.page.locator(SELECTORS.ASSISTANT_MESSAGE).count();
  }

  async waitForResponse(options: WaitForResponseOptions): Promise<WaitForResponseResult> {
    const {
      timeout = DEFAULT_TIMEOUT_MS,
      onChunk,
      quiet = false,
      initialMsgCount,
    } = options;

    progress('Waiting for response...', quiet);

    const completed = await this.waitForCompletionWithChunks(
      initialMsgCount,
      timeout,
      quiet,
      onChunk,
    );

    if (completed) {
      progress('Response complete', quiet);
    } else {
      progress(
        `Timed out after ${String(timeout)}ms — returning partial response`,
        quiet,
      );
    }

    const text = await this.getResponseAfter(initialMsgCount);
    return { text, completed };
  }

  /**
   * Return the text content of the most recent assistant message.
   */
  async getLastResponse(): Promise<string> {
    return this.page.evaluate((selector: string) => {
      const messages = document.querySelectorAll(selector);
      if (messages.length === 0) {
        return '';
      }
      const last = messages[messages.length - 1];
      return last.textContent.trim();
    }, SELECTORS.ASSISTANT_MESSAGE);
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Get the text of the latest assistant message that appeared after
   * `previousCount` messages. Returns '' if no new message exists.
   */
  private async getResponseAfter(previousCount: number): Promise<string> {
    return this.page.evaluate(
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

  /**
   * Wait for response completion using the stop-button as the primary signal.
   *
   * Strategy: the stop button appears while ChatGPT is generating a response
   * and disappears when generation finishes. This is more reliable than
   * copy-button counting because user messages also receive copy buttons.
   *
   * Returns `true` if the response completed, `false` on timeout.
   */
  private async waitForCompletionWithChunks(
    msgCountBefore: number,
    timeout: number,
    quiet: boolean,
    onChunk?: (text: string) => void,
  ): Promise<boolean> {
    let done = false;
    const stopBtn = this.page.locator(SELECTORS.STOP_BUTTON);

    const deadline = Date.now() + timeout;

    const completionPromise = (async (): Promise<boolean> => {
      // Phase 1: Wait for stop button to appear (generation started).
      // Uses the full timeout so slow-to-start responses aren't cut short.
      try {
        await stopBtn.waitFor({ state: 'attached', timeout });
      } catch (error: unknown) {
        if (!isTimeoutError(error)) {
          throw error;
        }
        // Stop button never appeared within the timeout.
        // For very fast responses the button may appear and disappear
        // before we observe it; check if a new assistant message arrived.
        const currentCount = await this.page
          .locator(SELECTORS.ASSISTANT_MESSAGE)
          .count();
        if (currentCount > msgCountBefore) {
          return true;
        }
        progress('Response not detected within timeout', quiet);
        return false;
      }

      // Phase 2: Wait for stop button to disappear (generation finished).
      // Use remaining time so total wait never exceeds the caller's timeout.
      const remaining = Math.max(deadline - Date.now(), 0);
      try {
        await stopBtn.waitFor({ state: 'detached', timeout: remaining });
        return true;
      } catch (error: unknown) {
        if (!isTimeoutError(error)) {
          throw error;
        }
        // Generation still running but we've hit the timeout — partial response.
        return false;
      }
    })().finally((): void => {
      done = true;
    });

    if (onChunk) {
      await this.pollChunks(() => done, msgCountBefore, quiet, onChunk);
    }

    return completionPromise;
  }

  /**
   * Poll the last assistant message text at regular intervals,
   * invoking `onChunk` whenever the text changes.
   */
  private async pollChunks(
    isDone: () => boolean,
    msgCountBefore: number,
    quiet: boolean,
    onChunk: (text: string) => void,
  ): Promise<void> {
    let lastText = '';

    while (!isDone()) {
      try {
        const currentText = await this.getResponseAfter(msgCountBefore);
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
}

// ── Helpers ────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Timeout');
}
