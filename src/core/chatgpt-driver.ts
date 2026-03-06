import type { Locator, Page } from 'playwright';
import { errors } from 'playwright';

import { CHATGPT_BASE_URL, conversationLinkById, SELECTORS } from '../constants/selectors.js';

import { progress } from './output-handler.js';

type StopButtonResult = 'attached' | 'message' | 'timeout';

export type ThinkingEffortLevel = 'light' | 'standard' | 'extended' | 'deep';

export interface ConversationItem {
  id: string;
  title: string;
  /** ISO timestamp if available from the DOM; empty string otherwise. */
  timestamp: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  href: string;
}

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

  // ── Navigation ────────────────────────────────────────────

  /**
   * Navigate to a specific chat by its ID.
   */
  async navigateToChat(chatId: string, quiet = false): Promise<void> {
    if (!/^[\w-]+$/.test(chatId)) {
      throw new Error(
        `Invalid chatId: "${chatId}". Must be non-empty and contain only alphanumeric characters, hyphens, or underscores.`,
      );
    }
    progress(`Navigating to chat: ${chatId}`, quiet);
    await this.page.goto(`${CHATGPT_BASE_URL}/c/${chatId}`, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForReady();
  }

  /**
   * Navigate to the ChatGPT home page (starts a new chat context).
   */
  async navigateToNewChat(quiet = false): Promise<void> {
    progress('Opening new chat...', quiet);
    await this.page.goto(CHATGPT_BASE_URL, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForReady();
  }

  /**
   * Navigate to a project page by project name.
   * Finds the matching project link in the sidebar and navigates to it.
   */
  async navigateToProject(name: string, quiet = false): Promise<void> {
    progress(`Navigating to project: ${name}`, quiet);

    const projects = await this.getProjectList();
    const match = projects.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (!match) {
      const available = projects.map((p) => p.name).join(', ');
      throw new Error(
        `Project "${name}" not found. Available projects: ${available || '(none)'}`,
      );
    }

    await this.page.goto(`${CHATGPT_BASE_URL}${match.href}`, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForReady();
  }

  // ── Chat management ────────────────────────────────────────

  /**
   * Get the list of conversations from the sidebar.
   * Uses evaluateAll for a single CDP round-trip.
   */
  async getConversationList(): Promise<ConversationItem[]> {
    return this.page.locator(SELECTORS.CONVERSATION_LINK).evaluateAll((els) =>
      els.reduce<{ id: string; title: string; timestamp: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
          const timeEl = el.querySelector('time');
          acc.push({
            id: href.replace('/c/', ''),
            title: (el.textContent || '').trim(),
            timestamp: timeEl?.getAttribute('datetime') ?? '',
          });
        }
        return acc;
      }, []),
    );
  }

  /**
   * Delete a conversation by ID via the sidebar context menu.
   */
  async deleteConversation(id: string, quiet = false): Promise<void> {
    progress(`Deleting conversation: ${id}`, quiet);
    const link = await this.openConversationMenu(id);

    await this.page.locator(SELECTORS.CONVERSATION_DELETE_OPTION).click();
    await this.page.locator(SELECTORS.CONVERSATION_DELETE_CONFIRM).click();

    await link.waitFor({ state: 'detached', timeout: 10_000 });
    progress('Conversation deleted', quiet);
  }

  /**
   * Archive a conversation by ID via the sidebar context menu.
   */
  async archiveConversation(id: string, quiet = false): Promise<void> {
    progress(`Archiving conversation: ${id}`, quiet);
    const link = await this.openConversationMenu(id);

    await this.page.locator(SELECTORS.CONVERSATION_ARCHIVE_OPTION).click();

    await link.waitFor({ state: 'detached', timeout: 10_000 });
    progress('Conversation archived', quiet);
  }

  // ── Project management ─────────────────────────────────────

  /**
   * Get the list of projects from the sidebar.
   * Uses evaluateAll for a single CDP round-trip.
   */
  async getProjectList(): Promise<ProjectItem[]> {
    return this.page.locator(SELECTORS.PROJECT_LINK).evaluateAll((els) =>
      els.reduce<{ id: string; name: string; href: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
          // href pattern: /g/{project-id}/project
          const segments = href.split('/').filter(Boolean);
          const id = segments.length >= 2 ? segments[1] : '';
          acc.push({ id, name: el.textContent.trim(), href });
        }
        return acc;
      }, []),
    );
  }

  /**
   * Get conversations within the currently open project page.
   * On a project page, ChatGPT's sidebar shows only that project's chats,
   * so we can safely delegate to getConversationList().
   */
  async getProjectConversationList(quiet = false): Promise<ConversationItem[]> {
    // Wait for sidebar conversation links to load after project page navigation.
    // TimeoutError is expected when the project has no chats, but could also
    // indicate a slow sidebar render — warn so automation can distinguish.
    try {
      await this.page.locator(SELECTORS.CONVERSATION_LINK).first().waitFor({
        state: 'attached',
        timeout: 10_000,
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        progress(
          'No conversation links found in sidebar (timeout). The project may have no chats, or the sidebar may be slow to load.',
          quiet,
        );
        return [];
      }
      throw error;
    }
    return this.getConversationList();
  }

  // ── Model & messaging ──────────────────────────────────────

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

    // Wait for the effort menu to render before probing labels.
    await this.page
      .locator(SELECTORS.THINKING_EFFORT_MENUITEM)
      .first()
      .waitFor({ state: 'visible' });

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
   * Locate a conversation link in the sidebar, hover to reveal the
   * three-dot menu, and click it. Returns the link locator for further use.
   */
  private async openConversationMenu(id: string): Promise<Locator> {
    const link = this.page.locator(conversationLinkById(id));
    if ((await link.count()) === 0) {
      throw new Error(
        `Conversation "${id}" not found in sidebar. Run "cavendish list" to see available chats.`,
      );
    }

    await link.hover();
    const menuButton = link.locator(SELECTORS.CONVERSATION_MENU_BUTTON);
    await menuButton.waitFor({ state: 'visible', timeout: 5000 });
    await menuButton.click();

    return link;
  }

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
