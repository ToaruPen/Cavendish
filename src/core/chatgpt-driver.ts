import type { Locator, Page } from 'playwright';
import { errors } from 'playwright';

import { SELECTORS } from '../constants/selectors.js';

import { progress } from './output-handler.js';

type StopButtonResult = 'attached' | 'message' | 'timeout';

export type ThinkingEffortLevel = 'light' | 'standard' | 'extended' | 'deep';

const THINKING_EFFORT_LEVELS: readonly ThinkingEffortLevel[] = [
  'light', 'standard', 'extended', 'deep',
] as const;

/** Candidate UI labels per effort level (Japanese + English). */
const EFFORT_LABEL_CANDIDATES: Record<ThinkingEffortLevel, readonly string[]> = {
  light: ['ライト', 'Light'],
  standard: ['標準', 'Standard'],
  extended: ['拡張', 'Extended'],
  deep: ['深い', 'Deep'],
};

type ThinkingModelCategory = 'thinking' | 'pro';

/** Valid effort levels per model category. */
const MODEL_EFFORT_LEVELS: Record<ThinkingModelCategory, readonly ThinkingEffortLevel[]> = {
  thinking: THINKING_EFFORT_LEVELS,
  pro: ['standard', 'extended'],
};

const DEFAULT_TIMEOUT_MS = 2_400_000;
const POLL_INTERVAL_MS = 200;

export interface WaitForResponseOptions {
  /** Timeout in milliseconds (default: 2_400_000). */
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

  /**
   * Set the thinking effort level in the ChatGPT composer.
   * Clicks the thinking effort pill and selects the desired level from the dropdown.
   */
  async setThinkingEffort(
    level: ThinkingEffortLevel,
    model: string,
    quiet = false,
  ): Promise<void> {
    const category = resolveModelCategory(model);
    if (category === undefined) {
      throw new Error(
        `Model "${model}" does not support --thinking-effort. Only Thinking and Pro models are supported.`,
      );
    }

    const allowedLevels = MODEL_EFFORT_LEVELS[category];
    if (!allowedLevels.includes(level)) {
      throw new Error(
        `Thinking effort "${level}" is not valid for ${category} models. Valid levels: ${allowedLevels.join(', ')}`,
      );
    }

    const candidates = EFFORT_LABEL_CANDIDATES[level];
    progress(`Setting thinking effort: ${level}`, quiet);

    const pill = this.page.locator(SELECTORS.THINKING_EFFORT_PILL);
    await pill.click();

    const menuItem = await this.findMenuItemByLabels(candidates);
    await menuItem.click();

    progress(`Thinking effort set to: ${level}`, quiet);
  }

  /**
   * Attach files to the ChatGPT composer using the hidden file input.
   * Uses Playwright's setInputFiles for reliable cross-browser file injection.
   */
  async attachFiles(filePaths: string[], quiet = false): Promise<void> {
    progress(`Attaching ${String(filePaths.length)} file(s)...`, quiet);

    const fileInput = this.page.locator(SELECTORS.FILE_INPUT_GENERIC);
    await fileInput.setInputFiles(filePaths);

    // Fixed delay while ChatGPT processes the attachment.
    // Replace with event-based wait when a suitable selector is identified.
    await this.page.waitForTimeout(2000);
    progress('Files attached', quiet);
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
   * Find a visible menuitemradio matching any of the given label candidates.
   * Tries each candidate in order and returns the first visible match.
   * Throws if none of the candidates match a visible menu item.
   */
  private async findMenuItemByLabels(candidates: readonly string[]): Promise<Locator> {
    for (const label of candidates) {
      const item = this.page
        .locator(SELECTORS.THINKING_EFFORT_MENUITEM)
        .filter({ hasText: label });
      const visible = await item.isVisible().catch((): boolean => false);
      if (visible) {
        return item;
      }
    }
    throw new Error(
      `Thinking effort menu item not found. Tried labels: ${candidates.join(', ')}`,
    );
  }

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
      // Phase 1: Race stop-button appearance against a new assistant message.
      // Standard models show the stop button first; Pro (thinking) models may
      // show the assistant message node first during the thinking phase.
      const stopButtonAppeared = await this.raceStopButtonAndMessage(
        stopBtn,
        msgCountBefore,
        timeout,
      );

      if (stopButtonAppeared === 'timeout') {
        progress(`Response not detected within ${String(timeout)}ms`, quiet);
        return false;
      }

      if (stopButtonAppeared === 'message') {
        // Assistant message appeared before stop button — common with Pro
        // (thinking phase creates the message node before streaming begins).
        // Use the full remaining timeout so long-running thinking phases
        // are not incorrectly cut short.
        const remainingForAttach = Math.max(deadline - Date.now(), 0);
        if (remainingForAttach <= 0) {
          return false;
        }
        try {
          await stopBtn.waitFor({ state: 'attached', timeout: remainingForAttach });
        } catch (error: unknown) {
          if (!isTimeoutError(error)) {
            throw error;
          }
          // Stop button never appeared within the overall timeout — partial.
          return false;
        }
      }

      // Phase 2: Stop button is attached — wait for it to disappear (generation finished).
      // Use remaining time so total wait never exceeds the caller's timeout.
      // Guard against 0: Playwright treats timeout=0 as "no timeout" (infinite).
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
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
   * Race the stop-button appearance against a new assistant message.
   *
   * Returns:
   * - `'attached'`  — stop button appeared first (proceed to Phase 2)
   * - `'message'`   — assistant message appeared first (e.g. Pro thinking phase)
   * - `'timeout'`   — neither appeared within the timeout
   */
  private async raceStopButtonAndMessage(
    stopBtn: Locator,
    msgCountBefore: number,
    timeout: number,
  ): Promise<StopButtonResult> {
    const deadline = Date.now() + timeout;
    const race = { settled: false };

    // Start listening for the stop button (non-blocking)
    const stopPromise = stopBtn
      .waitFor({ state: 'attached', timeout })
      .then((): StopButtonResult => 'attached')
      .catch((error: unknown): StopButtonResult => {
        if (isTimeoutError(error)) {
          return 'timeout';
        }
        throw error;
      });

    // Poll for a new assistant message in parallel.
    // Checks `race.settled` so it stops promptly when the other promise wins.
    const messagePromise = (async (): Promise<StopButtonResult> => {
      while (!race.settled && Date.now() < deadline) {
        const count = await this.page
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
  return error instanceof errors.TimeoutError;
}

/**
 * Determine the model category for thinking effort validation.
 * Returns undefined if the model does not support thinking effort.
 */
function resolveModelCategory(model: string): ThinkingModelCategory | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('thinking')) {return 'thinking';}
  if (lower.includes('pro')) {return 'pro';}
  return undefined;
}
