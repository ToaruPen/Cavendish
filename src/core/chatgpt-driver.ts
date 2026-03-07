import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import { errors } from 'playwright';

import { assertValidChatId, CHATGPT_BASE_URL, conversationLinkById, conversationLinkByIdBroad, MENU_LABELS, projectConversationLinkById, SELECTORS } from '../constants/selectors.js';

import { progress } from './output-handler.js';

type StopButtonResult = 'attached' | 'message' | 'timeout';

export type ThinkingEffortLevel = 'light' | 'standard' | 'extended' | 'deep';

export type DeepResearchExportFormat = 'markdown' | 'word' | 'pdf';

export interface ConversationItem {
  id: string;
  title: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  href: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
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
  /** Label prefix for progress messages (e.g. 'Deep Research'). Defaults to 'Response'. */
  label?: string;
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
    assertValidChatId(chatId);
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

    const projects = await this.getProjectList(quiet);
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

  // ── Deep Research ──────────────────────────────────────────

  /**
   * Navigate to the Deep Research page.
   */
  async navigateToDeepResearch(quiet = false): Promise<void> {
    progress('Opening Deep Research...', quiet);
    await this.page.goto(`${CHATGPT_BASE_URL}/deep-research`, {
      waitUntil: 'domcontentloaded',
    });
    await this.page.locator(SELECTORS.DEEP_RESEARCH_APP).waitFor({
      state: 'attached',
      timeout: 30_000,
    });
    await this.waitForReady();
  }

  /**
   * Type a message into the prompt and click the Deep Research send button.
   * The send button (`[data-testid="send-button"]`) only appears after text is entered.
   */
  async sendDeepResearchMessage(text: string): Promise<void> {
    await this.waitForReady();
    const input = this.page.locator(SELECTORS.PROMPT_INPUT);
    await input.fill(text);
    const sendBtn = this.page.locator(SELECTORS.SEND_BUTTON);
    await sendBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await sendBtn.click();
  }

  /**
   * Navigate to an existing DR chat and send a follow-up message.
   * Uses JavaScript click to avoid header overlay interception on chat pages.
   */
  async sendDeepResearchFollowUp(
    chatId: string,
    text: string,
    quiet = false,
  ): Promise<void> {
    await this.navigateToChat(chatId, quiet);

    const input = this.page.locator(SELECTORS.PROMPT_INPUT);
    await input.fill(text);

    // Wait for send button to appear after text entry
    await this.page.locator(SELECTORS.SEND_BUTTON).waitFor({
      state: 'visible',
      timeout: 5_000,
    });

    // Use JavaScript click — the sticky page-header intercepts Playwright
    // clicks on chat pages (its children have pointer-events: auto).
    const clicked = await this.page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (btn instanceof HTMLElement) { btn.click(); return true; }
      return false;
    }, SELECTORS.SEND_BUTTON);
    if (!clicked) {
      throw new Error('Send button not found after entering follow-up text');
    }
  }

  /**
   * Extract the chat ID from the current page URL.
   * Expected URL pattern: https://chatgpt.com/c/{chatId}
   */
  extractChatId(): string | undefined {
    const match = /\/c\/([^/?#]+)/.exec(this.page.url());
    return match?.[1];
  }

  /**
   * Extract the Deep Research response text from the nested iframe.
   *
   * DR responses are rendered inside a sandboxed iframe
   * (`iframe[title="internal://deep-research"]`) which itself contains
   * an `about:blank` child frame with the actual report content.
   */
  async getDeepResearchResponse(): Promise<string> {
    const contentFrame = this.getDeepResearchContentFrame();
    if (!contentFrame) {
      return '';
    }
    try {
      return await contentFrame.evaluate(
        () => {
          const main = document.querySelector('main');
          if (main) {
            return main.textContent ? main.textContent.trim() : '';
          }
          return document.body.textContent ? document.body.textContent.trim() : '';
        },
      );
    } catch (error: unknown) {
      if (isFrameDetachedError(error)) { return ''; }
      throw error;
    }
  }

  /**
   * Wait for a Deep Research response to complete.
   *
   * DR flow: send → plan display (with countdown) → click "開始する" →
   * research phase ("リサーチ中..." + "リサーチを停止する") → final report.
   *
   * Completion: the "リサーチを停止する" button disappears, then we wait
   * for the final report to render in the iframe.
   */
  async waitForDeepResearchResponse(options: {
    timeout?: number;
    quiet?: boolean;
  }): Promise<WaitForResponseResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const quiet = options.quiet ?? false;

    progress('Waiting for Deep Research response...', quiet);

    const deadline = Date.now() + timeout;

    // Phase 1: Wait for plan iframe and click "開始する"
    // Throws if start is not detected within timeout.
    await this.clickDeepResearchStart(deadline, quiet);

    // Phase 2: Wait for research to start (stop button appears in iframe).
    // Cap at 60s so fast/auto-finish runs and selector misses fall through
    // to Phase 4 quickly instead of waiting the full deadline.
    const STOP_DETECT_MS = 60_000;
    const stopDetectDeadline = Math.min(deadline, Date.now() + STOP_DETECT_MS);
    let researchStarted = false;
    while (Date.now() < stopDetectDeadline) {
      await delay(POLL_INTERVAL_MS * 5);
      if (await this.hasDeepResearchStopButton()) {
        researchStarted = true;
        progress('Researching...', quiet);
        break;
      }
    }

    if (!researchStarted) {
      // The stop button may have appeared and disappeared between polls
      // (fast/auto-finish runs). Fall through to Phase 4 to check for
      // an already-completed report instead of returning partial.
      progress('Stop button not observed, checking for report...', quiet);
    }

    // Phase 3: Wait for research to complete (stop button disappears)
    if (researchStarted) {
      let lastLoggedAt = Date.now();
      while (Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS * 5);
        if (!await this.hasDeepResearchStopButton()) {
          progress('Research phase complete, waiting for report...', quiet);
          break;
        }
        const now = Date.now();
        if (now - lastLoggedAt > 30_000) {
          progress('Still researching...', quiet);
          lastLoggedAt = now;
        }
      }
    }

    // Phase 4: Wait for the final report to render
    return this.waitForDeepResearchReport(deadline, timeout, quiet, researchStarted);
  }

  /**
   * Phase 4: Wait for the final report to render after research completes.
   *
   * @param seenStopButton - Whether the stop button was observed during Phase 2/3.
   *   When true, the stop button's disappearance is a reliable signal that
   *   research finished. When false (button appeared and disappeared between
   *   polls), we require text to change from the initial snapshot to distinguish
   *   the final report from leftover plan text.
   */
  private async waitForDeepResearchReport(
    deadline: number,
    timeout: number,
    quiet: boolean,
    seenStopButton: boolean,
  ): Promise<WaitForResponseResult> {
    const initialText = await this.getDeepResearchResponse();

    // If the stop button was observed and is now gone, non-empty text is the report.
    if (seenStopButton && initialText.length > 0 && !await this.hasDeepResearchStopButton()) {
      progress('Response complete', quiet);
      return { text: initialText, completed: true };
    }

    // When the stop button was never observed, we require evidence that the
    // text is the final report rather than leftover plan text.  Two signals:
    //   (a) text changed from the initial snapshot, OR
    //   (b) text has been stable (non-empty, no stop button) for several polls,
    //       meaning the report was already rendered before Phase 4 began.
    const STABLE_THRESHOLD = 3;
    let stableCount = 0;

    const reportDeadline = Math.min(deadline, Date.now() + 120_000);
    while (Date.now() < reportDeadline) {
      await delay(POLL_INTERVAL_MS * 5);
      const hasStop = await this.hasDeepResearchStopButton();
      const text = await this.getDeepResearchResponse();

      if (text.length > 0 && !hasStop) {
        if (seenStopButton || text !== initialText) {
          progress('Response complete', quiet);
          return { text, completed: true };
        }
        // Text unchanged from initial — count consecutive stable polls
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD) {
          progress('Response complete (stable)', quiet);
          return { text, completed: true };
        }
      } else {
        stableCount = 0;
      }
    }

    const partial = await this.getDeepResearchResponse();
    progress(`Timed out after ${String(timeout)}ms — returning partial response`, quiet);
    return { text: partial, completed: false };
  }

  /**
   * Check if the "リサーチを停止する" button is present in the DR iframe.
   */
  private async hasDeepResearchStopButton(): Promise<boolean> {
    const contentFrame = this.getDeepResearchContentFrame();
    if (!contentFrame) {
      return false;
    }
    try {
      const count = await contentFrame.locator(SELECTORS.DEEP_RESEARCH_STOP_BUTTON).count();
      return count > 0;
    } catch (error: unknown) {
      if (isFrameDetachedError(error)) { return false; }
      throw error;
    }
  }

  /**
   * Wait for the DR plan iframe to render, then click "開始する" to
   * skip the countdown and start research immediately.
   * Returns true if research was started (button clicked or auto-started).
   */
  private async clickDeepResearchStart(
    deadline: number,
    quiet: boolean,
  ): Promise<void> {
    // Cap at 120s so initialization failures are detected quickly,
    // but also respect the caller's deadline when it is shorter.
    const START_PHASE_MS = 120_000;
    const startDeadline = Math.min(deadline, Date.now() + START_PHASE_MS);
    while (Date.now() < startDeadline) {
      await delay(POLL_INTERVAL_MS * 5);

      // Research may auto-start after countdown — detect early
      if (await this.hasDeepResearchStopButton()) {
        progress('Research already started (auto-start)', quiet);
        return;
      }

      const contentFrame = this.getDeepResearchContentFrame();
      if (!contentFrame) {
        continue;
      }

      try {
        const startBtn = contentFrame.locator(SELECTORS.DEEP_RESEARCH_START_BUTTON);
        if (await startBtn.count() > 0) {
          progress('Plan ready — starting research...', quiet);
          await startBtn.first().click();
          return;
        }
      } catch (error: unknown) {
        if (!isFrameDetachedError(error)) { throw error; }
        // Frame not ready yet — retry
      }
    }
    throw new Error(
      'Deep Research start not detected within timeout. ' +
      'Check ChatGPT Pro status or selector changes.',
    );
  }

  /**
   * Get the inner content frame of the DR iframe.
   * The DR response is rendered inside a double-nested iframe:
   * page → iframe[title="internal://deep-research"] → iframe#root (about:blank)
   *
   * Uses the LAST matching frame so that follow-up responses (which add
   * a new iframe per turn) pick up the latest report, not the old one.
   */
  private getDeepResearchContentFrame(): Frame | undefined {
    const drFrames = this.page.frames().filter(
      (f) => f.url().includes(SELECTORS.DEEP_RESEARCH_FRAME_URL),
    );
    if (drFrames.length === 0) {
      return undefined;
    }
    const nested = drFrames[drFrames.length - 1].childFrames();
    return nested[0];
  }

  /**
   * Open the export menu in the DR iframe.
   * Waits for the export button to become visible before clicking.
   */
  private async openDeepResearchExportMenu(contentFrame: Frame): Promise<void> {
    const exportBtn = contentFrame.locator(SELECTORS.DEEP_RESEARCH_EXPORT_BUTTON);
    await exportBtn.first().waitFor({ state: 'visible', timeout: 5_000 });
    await exportBtn.first().click();
    await delay(POLL_INTERVAL_MS * 5);
  }

  /**
   * Copy the DR report content as clean Markdown via the iframe's
   * "コンテンツをコピーする" button. Returns the Markdown text from clipboard.
   * Throws on failure — callers are responsible for fallback handling.
   */
  async copyDeepResearchContent(): Promise<string> {
    const contentFrame = this.getDeepResearchContentFrame();
    if (!contentFrame) {
      throw new Error('Deep Research content frame not found');
    }

    try {
      // Clear clipboard before copy so we can verify the write succeeded
      await this.page.evaluate(() => navigator.clipboard.writeText(''));

      await this.openDeepResearchExportMenu(contentFrame);

      // Click "コンテンツをコピーする"
      const copyBtn = contentFrame.locator(SELECTORS.DEEP_RESEARCH_COPY_CONTENT);
      await copyBtn.click();
      await delay(POLL_INTERVAL_MS * 5);

      // Read from clipboard and verify it was actually updated
      const copied = await this.page.evaluate(
        () => navigator.clipboard.readText(),
      );
      if (copied.length === 0) {
        throw new Error('Clipboard was not updated after copy-content click');
      }
      return copied;
    } catch (error: unknown) {
      if (isFrameDetachedError(error)) {
        throw new Error('Deep Research iframe was replaced during copy. Try again.');
      }
      throw error;
    }
  }

  /**
   * Export the DR report to a file (markdown, word, or pdf).
   * Clicks the export menu item and captures the browser download.
   * Returns the path to the saved file.
   */
  async exportDeepResearch(
    format: DeepResearchExportFormat,
    savePath: string,
    quiet = false,
  ): Promise<string> {
    const contentFrame = this.getDeepResearchContentFrame();
    if (!contentFrame) {
      throw new Error('Deep Research iframe not found — is the report loaded?');
    }

    const selectorMap: Record<DeepResearchExportFormat, string> = {
      markdown: SELECTORS.DEEP_RESEARCH_EXPORT_MARKDOWN,
      word: SELECTORS.DEEP_RESEARCH_EXPORT_WORD,
      pdf: SELECTORS.DEEP_RESEARCH_EXPORT_PDF,
    };

    progress(`Exporting report as ${format}...`, quiet);

    try {
      await this.openDeepResearchExportMenu(contentFrame);

      // Set up download listener before clicking
      const downloadPromise = this.page.waitForEvent('download', { timeout: 60_000 });

      // Click the format-specific button
      const formatBtn = contentFrame.locator(selectorMap[format]);
      await formatBtn.click();

      const download = await downloadPromise;
      await download.saveAs(savePath);

      progress(`Report saved to ${savePath}`, quiet);
      return savePath;
    } catch (error: unknown) {
      if (isFrameDetachedError(error)) {
        throw new Error(`Export failed — iframe was replaced during export. Try again.`);
      }
      throw error;
    }
  }

  // ── Chat management ────────────────────────────────────────

  /**
   * Get the list of conversations from the sidebar.
   * Waits for the sidebar container before reading links so that an empty
   * result reflects a genuinely empty sidebar, not a loading delay.
   * Uses evaluateAll for a single CDP round-trip.
   */
  async getConversationList(quiet = false): Promise<ConversationItem[]> {
    await this.waitForSidebarContainer(quiet);
    return this.page.locator(SELECTORS.CONVERSATION_LINK).evaluateAll((els, selector) =>
      els.reduce<{ id: string; title: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
          // Expected href pattern: /c/{chat-id}
          const match = /^\/c\/([^/?#]+)$/.exec(href);
          if (!match) {
            throw new Error(
              `Unexpected conversation href format: "${href}" (selector: ${selector})`,
            );
          }
          acc.push({
            id: match[1],
            title: (el.textContent || '').trim(),
          });
        }
        return acc;
      }, []),
    SELECTORS.CONVERSATION_LINK);
  }

  /**
   * Delete a conversation by ID via the sidebar context menu.
   */
  async deleteConversation(id: string, quiet = false): Promise<void> {
    progress(`Deleting conversation: ${id}`, quiet);
    const link = await this.openConversationMenu(id, quiet);
    await this.confirmDeleteAndWait(link);
    progress('Conversation deleted', quiet);
  }

  /**
   * Archive a conversation by ID via the sidebar context menu.
   */
  async archiveConversation(id: string, quiet = false): Promise<void> {
    progress(`Archiving conversation: ${id}`, quiet);
    const link = await this.openConversationMenu(id, quiet);

    await this.page.locator(SELECTORS.CONVERSATION_ARCHIVE_OPTION).click();

    await link.waitFor({ state: 'detached', timeout: 10_000 });
    progress('Conversation archived', quiet);
  }

  // ── Project management ─────────────────────────────────────

  /**
   * Get the list of projects from the sidebar.
   * Uses evaluateAll for a single CDP round-trip.
   */
  async getProjectList(quiet = false): Promise<ProjectItem[]> {
    await this.waitForSidebarContainer(quiet);
    return this.page.locator(SELECTORS.PROJECT_LINK).evaluateAll((els) =>
      els.reduce<{ id: string; name: string; href: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
          // Expected href pattern: /g/{project-id}/project
          const segments = href.split('/').filter(Boolean);
          if (segments[0] !== 'g' || segments.length < 3 || segments[2] !== 'project') {
            return acc; // skip non-project links (selector is broad: href*="/project")
          }
          acc.push({ id: segments[1], name: el.textContent.trim(), href });
        }
        return acc;
      }, []),
    );
  }

  /**
   * Get conversations within the currently open project page.
   * Uses the broad conversation link selector that matches both
   * regular (/c/{id}) and project (/g/.../c/{id}) chat URLs.
   */
  async getProjectConversationList(quiet = false): Promise<ConversationItem[]> {
    await this.waitForReady();
    // Wait for project chat links to render in main content area.
    // Timeout means the project has no chats; other errors are re-thrown.
    try {
      await this.page.locator(SELECTORS.PROJECT_CONVERSATION_LINK).first().waitFor({
        state: 'attached',
        timeout: 5000,
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        progress('No project conversations found', quiet);
        return [];
      }
      throw error;
    }
    return this.page.locator(SELECTORS.PROJECT_CONVERSATION_LINK).evaluateAll((els) =>
      els.reduce<{ id: string; title: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
          const match = /\/c\/([^/?#]+)$/.exec(href);
          if (match) {
            acc.push({
              id: match[1],
              title: (el.textContent || '').trim(),
            });
          }
        }
        return acc;
      }, []),
    );
  }

  /**
   * Delete a project conversation by ID via the project conversation context menu.
   */
  async deleteProjectConversation(id: string, quiet = false): Promise<void> {
    progress(`Deleting project conversation: ${id}`, quiet);
    const link = await this.openProjectConversationMenu(id);
    await this.confirmDeleteAndWait(link);
    progress('Project conversation deleted', quiet);
  }

  /**
   * Create a new project via the sidebar UI.
   * Expands the project section, clicks the create button,
   * fills the name in the modal, and confirms.
   */
  async createProject(name: string, quiet = false): Promise<void> {
    progress(`Creating project: ${name}`, quiet);

    await this.waitForSidebarContainer(quiet);

    // Expand the project section in the sidebar (only if collapsed)
    const sectionToggle = this.page.locator(SELECTORS.PROJECT_SECTION_TOGGLE).first();
    const expanded = await sectionToggle.getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await sectionToggle.click();
    }

    // Click the "new project" button (now visible)
    const newBtn = this.page.locator(SELECTORS.NEW_PROJECT_BUTTON);
    await newBtn.waitFor({ state: 'visible', timeout: 5000 });
    await newBtn.click();

    // Fill the project name in the modal
    const nameInput = this.page.locator(SELECTORS.PROJECT_NAME_INPUT);
    await nameInput.waitFor({ state: 'visible', timeout: 5000 });
    await nameInput.fill(name);

    // Click the confirm button (becomes enabled after name is filled)
    const confirmBtn = this.page.locator(SELECTORS.PROJECT_CREATE_CONFIRM);
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
    const urlBeforeCreate = this.page.url();
    await confirmBtn.click();

    await this.page.waitForURL(
      (url) => url.toString() !== urlBeforeCreate && /\/g\/.*\/project/.test(url.toString()),
      { timeout: 10_000 },
    );

    progress(`Project created: ${name}`, quiet);
  }

  /**
   * Move a conversation to a project via the conversation context menu.
   */
  async moveToProject(chatId: string, projectName: string, quiet = false): Promise<void> {
    progress(`Moving conversation ${chatId} to project: ${projectName}`, quiet);

    await this.waitForSidebarContainer(quiet);
    const link = this.page.locator(conversationLinkByIdBroad(chatId));
    try {
      await link.waitFor({ state: 'attached', timeout: 5000 });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Conversation "${chatId}" not found in sidebar. Run "cavendish list" to see available chats.`,
        );
      }
      throw error;
    }

    await link.hover();
    const menuButton = link.locator(SELECTORS.CONVERSATION_MENU_BUTTON);
    await menuButton.waitFor({ state: 'visible', timeout: 5000 });
    await menuButton.click();

    await this.page.locator(SELECTORS.CONVERSATION_MOVE_TO_PROJECT_OPTION).click();

    const projectItem = this.page
      .locator(SELECTORS.PROJECT_PICKER_ITEM)
      .filter({ hasText: projectName });

    // Wait for the project picker submenu to render before checking matches
    try {
      await projectItem.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        await this.page.keyboard.press('Escape');
        throw new Error(
          `Project "${projectName}" not found in project picker.`,
        );
      }
      throw error;
    }

    const count = await projectItem.count();
    if (count > 1) {
      // Multiple partial matches — find exact match by text content
      for (let i = 0; i < count; i++) {
        const text = await projectItem.nth(i).textContent();
        if (text?.trim() === projectName) {
          await projectItem.nth(i).click();
          progress(`Conversation moved to project: ${projectName}`, quiet);
          return;
        }
      }
      await this.page.keyboard.press('Escape');
      throw new Error(
        `Multiple projects partially match "${projectName}" but none is an exact match. Please use the full project name.`,
      );
    }
    await projectItem.first().click();

    progress(`Conversation moved to project: ${projectName}`, quiet);
  }

  // ── Composer + menu (submenu navigation) ───────────────────

  /**
   * Open the composer + menu and navigate to a menu item by label path.
   * Supports nested submenus via hover-to-expand (Radix UI behavior).
   *
   * Each step in the path can be a single label string or an array of
   * locale candidates (tried in order). This supports bilingual menus
   * (e.g. Japanese + English).
   *
   * @param labelPath - e.g. [['さらに表示', 'Show more'], 'GitHub']
   */
  async openComposerMenuItem(
    labelPath: (string | string[])[],
    quiet = false,
  ): Promise<void> {
    const labels = labelPath.map((s) => (Array.isArray(s) ? s[0] : s));
    progress(`Opening composer menu: ${labels.join(' → ')}`, quiet);

    await this.waitForReady();
    await this.page.locator(SELECTORS.COMPOSER_PLUS_BUTTON).click();

    await this.page.locator(SELECTORS.MENU_ITEM).first().waitFor({
      state: 'visible',
      timeout: 5000,
    });

    // Track the number of menu items matched so far to handle duplicate
    // labels at different nesting levels (e.g. 'さらに表示' appearing in
    // both the parent and child menus). At each step we skip previously
    // matched items using nth().
    const matchedCountByLabel = new Map<string, number>();

    for (let i = 0; i < labelPath.length; i++) {
      const candidates = Array.isArray(labelPath[i])
        ? labelPath[i] as string[]
        : [labelPath[i] as string];
      const isLast = i === labelPath.length - 1;

      const menuItem = await this.findVisibleMenuItemWithRetry(candidates, matchedCountByLabel, 3, quiet);
      if (!menuItem) {
        await this.page.keyboard.press('Escape');
        throw new Error(
          `Menu item not found at step ${String(i + 1)} of path [${labels.join(', ')}]. `
          + `Tried labels: [${candidates.join(', ')}], selector: ${SELECTORS.MENU_ITEM}`,
        );
      }

      if (isLast) {
        await menuItem.click();
      } else {
        await menuItem.hover();
        await delay(300);
      }
    }
  }

  // ── Google Drive attachment ────────────────────────────────

  /**
   * Attach files from Google Drive via the Picker iframe.
   * Opens the composer + menu, selects "Google Drive から追加する",
   * searches for the file in the Picker, and selects it.
   */
  async attachGoogleDriveFile(fileName: string, quiet = false): Promise<void> {
    progress(`Attaching Google Drive file: ${fileName}`, quiet);

    await this.openComposerMenuItem(
      [[...MENU_LABELS.ADD_FROM_GOOGLE_DRIVE]],
      quiet,
    );

    // Wait for the Google Picker iframe to load
    const pickerFrame = await this.waitForGooglePickerFrame();

    // Wait for the search input to be ready (do NOT wait for initial result
    // items — some users' Picker opens with an empty view).
    const searchInput = pickerFrame.locator(SELECTORS.GDRIVE_PICKER_SEARCH);
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });

    // Search for the file
    await searchInput.fill(fileName);
    await searchInput.press('Enter');

    // Wait for search results and click the exact match
    await this.waitForPickerExactMatch(pickerFrame, fileName);

    // Record current attachment count before selecting
    const tileCountBefore = await this.page
      .locator(SELECTORS.FILE_ATTACHMENT_TILE)
      .count();

    // Click the select button in the Picker (use first() to avoid strict mode with duplicate buttons)
    const selectButton = pickerFrame.locator(SELECTORS.GDRIVE_PICKER_SELECT_BUTTON).first();
    await selectButton.click();

    // Wait for the Picker to close (iframe detaches)
    await this.page.locator(SELECTORS.GDRIVE_PICKER_IFRAME).waitFor({
      state: 'detached',
      timeout: 10_000,
    });

    // Wait for the composer attachment tile to appear
    await this.waitForAttachmentTiles(tileCountBefore + 1);

    progress(`Google Drive file attached: ${fileName}`, quiet);
  }

  // ── GitHub integration ────────────────────────────────────

  /**
   * Enable GitHub integration in the composer and select a repository.
   * Navigates through the submenu: + → さらに表示 → GitHub
   * Then opens the repo picker and selects the specified repository.
   */
  async attachGitHubRepo(repo: string, quiet = false): Promise<void> {
    progress(`Attaching GitHub repo: ${repo}`, quiet);

    const githubPill = this.page.locator(SELECTORS.GITHUB_FOOTER_BUTTON);
    const alreadyEnabled = await githubPill.isVisible().catch((): boolean => false);

    if (!alreadyEnabled) {
      // Navigate through nested submenus to enable GitHub (first repo only)
      await this.openComposerMenuItem(
        [[...MENU_LABELS.SHOW_MORE], ...MENU_LABELS.GITHUB],
        quiet,
      );
      await githubPill.waitFor({ state: 'visible', timeout: 5000 });
    }

    // Click GitHub pill to open repo picker
    await githubPill.click();

    // Search for the repository
    const repoSearch = this.page.locator(SELECTORS.GITHUB_REPO_SEARCH);
    await repoSearch.waitFor({ state: 'visible', timeout: 5000 });
    await repoSearch.fill(repo);

    // Find and click the matching repository in the popover
    const popover = this.page.locator(SELECTORS.POPOVER_CONTENT);
    const repoItem = popover.getByText(repo, { exact: true }).first();

    try {
      await repoItem.waitFor({ state: 'visible', timeout: 5000 });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        await this.page.keyboard.press('Escape');
        throw new Error(
          `GitHub repository "${repo}" not found in picker. Ensure the repo is registered in ChatGPT's GitHub app settings.`,
        );
      }
      throw error;
    }
    await repoItem.click();

    // Close the repo picker (multi-select popover stays open after selection)
    await this.page.keyboard.press('Escape');
    await popover.waitFor({ state: 'hidden', timeout: 5000 });

    progress(`GitHub repo attached: ${repo}`, quiet);
  }

  // ── Agent Mode ──────────────────────────────────────────────

  /**
   * Enable agent mode in the composer.
   * Navigates through the submenu: + → さらに表示 → エージェントモード
   * If agent mode is already active (pill visible), this is a no-op.
   */
  async enableAgentMode(quiet = false): Promise<void> {
    progress('Enabling agent mode...', quiet);

    const pill = this.page.locator(SELECTORS.AGENT_MODE_PILL);
    const alreadyActive = await pill.isVisible().catch((): boolean => false);
    if (alreadyActive) {
      progress('Agent mode already active', quiet);
      return;
    }

    await this.openComposerMenuItem(
      [[...MENU_LABELS.SHOW_MORE], [...MENU_LABELS.AGENT_MODE]],
      quiet,
    );

    await pill.waitFor({ state: 'visible', timeout: 5000 });
    progress('Agent mode enabled', quiet);
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

    // Wait for the exact number of file tiles to appear in the composer.
    await this.waitForAttachmentTiles(filePaths.length);
    progress('Files attached', quiet);
  }

  async waitForResponse(options: WaitForResponseOptions): Promise<WaitForResponseResult> {
    const {
      timeout = DEFAULT_TIMEOUT_MS,
      onChunk,
      quiet = false,
      initialMsgCount,
      label = 'Response',
    } = options;

    progress(`Waiting for ${label}...`, quiet);

    const completed = await this.waitForCompletionWithChunks(
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

  // ── Reading ───────────────────────────────────────────────

  /**
   * Read all messages from a conversation.
   *
   * Navigates to the chat and extracts user/assistant messages in DOM order.
   * Consecutive assistant messages (e.g. thinking steps from reasoning models)
   * are grouped into a single turn; only the last message in each group is kept.
   */
  async readConversation(chatId: string, quiet = false): Promise<ConversationMessage[]> {
    await this.navigateToChat(chatId, quiet);

    // Wait for at least one message to render after navigation.
    const messageSelector = `${SELECTORS.USER_MESSAGE}, ${SELECTORS.ASSISTANT_MESSAGE}`;
    await this.page.locator(messageSelector).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    });

    progress('Reading conversation messages...', quiet);

    const rawMessages = await this.page.evaluate(
      ({ userSel, assistantSel }: { userSel: string; assistantSel: string }) => {
        const allowedRoles = new Set(['user', 'assistant']);
        const allElements = document.querySelectorAll(
          `${userSel}, ${assistantSel}`,
        );
        const result: { role: 'user' | 'assistant'; content: string }[] = [];
        for (const el of allElements) {
          const role = el.getAttribute('data-message-author-role');
          if (!role || !allowedRoles.has(role)) {
            throw new Error(
              `Unexpected data-message-author-role: "${String(role)}". Expected "user" or "assistant".`,
            );
          }
          result.push({ role: role as 'user' | 'assistant', content: (el.textContent || '').trim() });
        }
        return result;
      },
      {
        userSel: SELECTORS.USER_MESSAGE,
        assistantSel: SELECTORS.ASSISTANT_MESSAGE,
      },
    );

    // Collapse consecutive assistant messages into one turn (keep last).
    // Thinking models emit multiple assistant nodes per turn.
    const messages: ConversationMessage[] = [];
    for (const msg of rawMessages) {
      if (
        msg.role === 'assistant' &&
        messages.length > 0 &&
        messages[messages.length - 1].role === 'assistant'
      ) {
        // Replace previous assistant message with this one (keep last in group)
        messages[messages.length - 1] = msg;
      } else {
        messages.push(msg);
      }
    }

    progress(`Read ${String(messages.length)} message(s)`, quiet);
    return messages;
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Wait for the Google Picker iframe to load and return its Frame object.
   * Playwright can access cross-origin iframes within the same browser context.
   */
  private async waitForGooglePickerFrame(): Promise<FrameLocator> {
    try {
      await this.page.locator(SELECTORS.GDRIVE_PICKER_IFRAME).waitFor({
        state: 'attached',
        timeout: 15_000,
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Google Picker iframe not found (selector: ${SELECTORS.GDRIVE_PICKER_IFRAME}). `
          + 'Verify that Google Drive is linked to your ChatGPT account and the Picker UI has not changed.',
        );
      }
      throw error;
    }
    return this.page.frameLocator(SELECTORS.GDRIVE_PICKER_IFRAME);
  }

  /**
   * Click the delete option, confirm, and wait for the link to disappear.
   * Shared by deleteConversation and deleteProjectConversation.
   */
  private async confirmDeleteAndWait(link: Locator): Promise<void> {
    await this.page.locator(SELECTORS.CONVERSATION_DELETE_OPTION).click();
    await this.page.locator(SELECTORS.CONVERSATION_DELETE_CONFIRM).click();
    await link.waitFor({ state: 'detached', timeout: 10_000 });
  }

  /**
   * Wait for the sidebar history container to be present in the DOM.
   * Unlike waitForSidebarLinks, this does NOT require links to exist —
   * an empty sidebar (0 conversations) is a valid state.
   */
  private async waitForSidebarContainer(quiet: boolean): Promise<void> {
    try {
      await this.page.locator(SELECTORS.SIDEBAR_HISTORY).waitFor({
        state: 'attached',
        timeout: 10_000,
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Sidebar container (${SELECTORS.SIDEBAR_HISTORY}) not found within 10s. The page may not have loaded correctly.`,
        );
      }
      throw error;
    }
    progress('Sidebar ready', quiet);
  }

  /**
   * Locate a conversation link in the sidebar, hover to reveal the
   * three-dot menu, and click it. Returns the link locator for further use.
   */
  private async openConversationMenu(id: string, quiet = false): Promise<Locator> {
    await this.waitForSidebarContainer(quiet);
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
   * Locate a project conversation link in the main content area, hover to
   * reveal the overflow menu, and click it.
   * Returns the link locator for detachment checks.
   */
  private async openProjectConversationMenu(id: string): Promise<Locator> {
    await this.waitForReady();
    const link = this.page.locator(projectConversationLinkById(id));
    try {
      await link.waitFor({ state: 'attached', timeout: 5000 });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new Error(
          `Project conversation "${id}" not found. Run "cavendish projects --name <project> --chats" to see available chats.`,
        );
      }
      throw error;
    }

    await link.hover();
    const menuButton = link.locator(SELECTORS.PROJECT_CONVERSATION_MENU_BUTTON);
    await menuButton.waitFor({ state: 'visible', timeout: 5000 });
    await menuButton.click();

    return link;
  }

  /**
   * Find a visible menu item matching any of the given label candidates.
   * Retries up to `timeout` ms to handle submenu render delays after hover.
   * Uses `matchedCountByLabel` to skip previously matched items with
   * the same label, allowing correct navigation through nested menus
   * where a label like "さらに表示" appears at multiple nesting levels.
   */
  private async findVisibleMenuItemWithRetry(
    candidates: string[],
    matchedCountByLabel: Map<string, number>,
    maxAttempts = 3,
    quiet = false,
  ): Promise<Locator | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const found = await this.findVisibleMenuItem(candidates, matchedCountByLabel);
      if (found) {return found;}
      if (attempt < maxAttempts) {
        progress(
          `Menu item retry ${String(attempt)}/${String(maxAttempts)} — candidates: [${candidates.join(', ')}], selector: ${SELECTORS.MENU_ITEM}`,
          quiet,
        );
        await delay(1000);
      }
    }
    return null;
  }

  /** Single-pass search for a visible menu item matching any candidate label. */
  private async findVisibleMenuItem(
    candidates: string[],
    matchedCountByLabel: Map<string, number>,
  ): Promise<Locator | null> {
    for (const label of candidates) {
      const allItems = this.page
        .locator(SELECTORS.MENU_ITEM)
        .filter({ hasText: label });
      const skipCount = matchedCountByLabel.get(label) ?? 0;
      let visibleCount = 0;
      const totalCount = await allItems.count();
      for (let i = 0; i < totalCount; i++) {
        const item = allItems.nth(i);
        if (await item.isVisible().catch((): boolean => false)) {
          if (visibleCount === skipCount) {
            matchedCountByLabel.set(label, skipCount + 1);
            return item;
          }
          visibleCount++;
        }
      }
    }
    return null;
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
   * Poll Google Picker search results until an exact file name match appears,
   * then click it. Handles the async nature of Picker search updates.
   * Throws if no match is found within 15s, or if multiple exact matches exist.
   */
  private async waitForPickerExactMatch(
    pickerFrame: FrameLocator,
    fileName: string,
  ): Promise<void> {
    const allResults = pickerFrame.locator(SELECTORS.GDRIVE_PICKER_RESULT_ITEM);
    const deadline = Date.now() + 15_000;
    let exactMatchIndex = -1;

    while (Date.now() < deadline) {
      try {
        await allResults.first().waitFor({
          state: 'attached',
          timeout: Math.max(deadline - Date.now(), 1000),
        });
      } catch (error: unknown) {
        if (isTimeoutError(error)) {
          throw new Error(
            `Google Drive file "${fileName}" not found in Picker search results.`,
          );
        }
        throw error;
      }

      const match = await this.findExactPickerMatch(allResults, fileName);
      if (match.ambiguous) {
        throw new Error(
          `Multiple Google Drive files match "${fileName}" exactly. Rename duplicates to disambiguate.`,
        );
      }
      if (match.index !== -1) {
        exactMatchIndex = match.index;
        break;
      }
      await delay(500);
    }

    if (exactMatchIndex === -1) {
      throw new Error(
        `Google Drive file "${fileName}" not found in Picker search results (no exact match).`,
      );
    }
    await allResults.nth(exactMatchIndex).click();
  }

  /**
   * Scan Picker result items for an exact first-line text match.
   * Returns the matching index, or -1 if not found. Sets `ambiguous` if duplicates.
   */
  private async findExactPickerMatch(
    allResults: Locator,
    fileName: string,
  ): Promise<{ index: number; ambiguous: boolean }> {
    const count = await allResults.count();
    let matchIndex = -1;
    for (let i = 0; i < count; i++) {
      const itemText = await allResults.nth(i).innerText();
      const firstLine = itemText.split('\n')[0].trim();
      if (firstLine === fileName) {
        if (matchIndex !== -1) {
          return { index: matchIndex, ambiguous: true };
        }
        matchIndex = i;
      }
    }
    return { index: matchIndex, ambiguous: false };
  }

  /** Wait for at least `expected` attachment tiles to appear in the composer. */
  private async waitForAttachmentTiles(expected: number): Promise<void> {
    await this.page.waitForFunction(
      ({ selector, count }: { selector: string; count: number }) =>
        document.querySelectorAll(selector).length >= count,
      { selector: SELECTORS.FILE_ATTACHMENT_TILE, count: expected },
      { timeout: 10_000 },
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
      const phase1Ok = await this.waitForStopButtonAttach(
        stopBtn, msgCountBefore, timeout, deadline, quiet,
      );
      if (!phase1Ok) {
        return false;
      }
      return this.waitForStopButtonCycle(
        stopBtn, msgCountBefore, deadline, quiet,
      );
    })().finally((): void => {
      done = true;
    });

    if (onChunk) {
      await this.pollChunks(() => done, msgCountBefore, quiet, onChunk);
    }

    return completionPromise;
  }

  /**
   * Phase 1: Wait for the stop button to become attached.
   * Races stop-button appearance against a new assistant message.
   * Returns true when the stop button is attached, false on timeout.
   */
  private async waitForStopButtonAttach(
    stopBtn: Locator,
    msgCountBefore: number,
    timeout: number,
    deadline: number,
    quiet: boolean,
  ): Promise<boolean> {
    const result = await this.raceStopButtonAndMessage(
      stopBtn, msgCountBefore, timeout,
    );

    if (result === 'timeout') {
      progress(`Response not detected within ${String(timeout)}ms`, quiet);
      return false;
    }

    if (result === 'attached') {
      return true;
    }

    // 'message' — assistant message appeared before stop button (Pro thinking).
    const remaining = Math.max(deadline - Date.now(), 0);
    if (remaining <= 0) {
      return false;
    }
    try {
      await stopBtn.waitFor({ state: 'attached', timeout: remaining });
      return true;
    } catch (error: unknown) {
      if (!isTimeoutError(error)) {
        throw error;
      }
      return false;
    }
  }

  /**
   * Phase 2: Wait for the stop button to disappear AND a non-empty response.
   * Pro models may cycle the stop button (thinking gap → response streaming),
   * so we loop until both conditions are met.
   */
  private async waitForStopButtonCycle(
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

      // Stop button gone — check if we actually have a response.
      const responseText = await this.getResponseAfter(msgCountBefore);
      if (responseText.length > 0) {
        return true;
      }

      // No response yet (Pro thinking phase gap). Wait for stop button
      // to reappear or an assistant message to arrive, whichever comes first.
      progress('Waiting for response to render...', quiet);
      const nextSignal = await this.waitForStopButtonOrResponse(
        stopBtn, msgCountBefore, deadline,
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
   * Wait for either the stop button to reappear or a non-empty assistant
   * response, whichever comes first. Used during the Pro model gap between
   * thinking completion and response streaming.
   *
   * Returns:
   * - `'stop-button'` — stop button reappeared (loop back to Phase 2)
   * - `'response'`    — non-empty assistant message arrived
   * - `'timeout'`     — deadline reached
   */
  private async waitForStopButtonOrResponse(
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
        const text = await this.getResponseAfter(msgCountBefore);
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
 * Check if an error is caused by a detached frame or destroyed execution context.
 * These are expected during iframe replacement in Deep Research.
 */
function isFrameDetachedError(error: unknown): boolean {
  if (!(error instanceof Error)) { return false; }
  const msg = error.message;
  return msg.includes('frame was detached') ||
    msg.includes('Execution context was destroyed');
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
