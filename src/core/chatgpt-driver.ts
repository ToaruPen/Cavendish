/**
 * Drives the ChatGPT Web UI via Playwright Page interactions.
 *
 * This is a facade class that delegates domain-specific operations
 * to focused sub-modules in ./driver/:
 *   - deep-research.ts — Deep Research navigation, wait, export, copy
 *   - attachments.ts — Google Drive, GitHub, Agent Mode, file attach
 *   - response-handler.ts — response completion detection and streaming
 *
 * Shared constants live in model-config.ts and chatgpt-types.ts.
 * All DOM selectors are sourced from constants/selectors.ts.
 */

import type { Locator, Page } from 'playwright';

import { assertValidChatId, CHATGPT_BASE_URL, conversationLinkById, conversationLinkByIdBroad, projectConversationLinkById, SELECTORS } from '../constants/selectors.js';

import type { ConversationItem, ConversationMessage, DeepResearchExportFormat, ProjectItem, WaitForResponseOptions, WaitForResponseResult } from './chatgpt-types.js';
import { attachFiles as attachFilesImpl, attachGitHubRepo as attachGitHubRepoImpl, attachGoogleDriveFile as attachGoogleDriveFileImpl, enableAgentMode as enableAgentModeImpl } from './driver/attachments.js';
import { copyDeepResearchContent as copyDRContent, exportDeepResearch as exportDR, getDeepResearchResponse as getDRResponse, navigateToDeepResearch as navToDR, refreshDeepResearch as refreshDR, sendDeepResearchFollowUp as sendDRFollowUp, sendDeepResearchMessage as sendDRMsg, waitForDeepResearchResponse as waitForDRResponse } from './driver/deep-research.js';
import { delay, isTimeoutError } from './driver/helpers.js';
import { getAssistantMessageCount as getAssistantMsgCount, getLastResponse as getLastResp, waitForResponse as waitForResp } from './driver/response-handler.js';
import { EFFORT_LABEL_CANDIDATES, MODEL_EFFORT_LEVELS, resolveModelCategory } from './model-config.js';
import type { ThinkingEffortLevel } from './model-config.js';
import { progress } from './output-handler.js';

// Re-export types for consumers
export type { ConversationItem, ConversationMessage, DeepResearchExportFormat, ProjectItem, WaitForResponseOptions, WaitForResponseResult } from './chatgpt-types.js';
export type { ThinkingEffortLevel } from './model-config.js';

export class ChatGPTDriver {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ── Navigation ────────────────────────────────────────────

  async navigateToChat(chatId: string, quiet = false, href?: string): Promise<void> {
    assertValidChatId(chatId);
    progress(`Navigating to chat: ${chatId}`, quiet);
    const url = href
      ? `${CHATGPT_BASE_URL}${href}`
      : `${CHATGPT_BASE_URL}/c/${chatId}`;
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForReady();
  }

  async navigateToNewChat(quiet = false): Promise<void> {
    progress('Opening new chat...', quiet);
    await this.page.goto(CHATGPT_BASE_URL, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForReady();
  }

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

  /** Return the current page URL (for diagnostics / error messages). */
  getCurrentUrl(): string {
    return this.page.url();
  }

  extractChatId(): string | undefined {
    const match = /\/c\/([^/?#]+)/.exec(this.page.url());
    return match?.[1];
  }

  // ── Deep Research (delegated) ─────────────────────────────

  async navigateToDeepResearch(quiet = false): Promise<void> {
    await navToDR(this.page, quiet);
  }

  async sendDeepResearchMessage(text: string): Promise<void> {
    await sendDRMsg(this.page, text);
  }

  async sendDeepResearchFollowUp(
    chatId: string,
    text: string,
    quiet = false,
    deadline?: number,
  ): Promise<string> {
    await this.navigateToChat(chatId, quiet);
    return sendDRFollowUp(this.page, text, { quiet, deadline });
  }

  async refreshDeepResearch(
    chatId: string,
    quiet = false,
    deadline?: number,
  ): Promise<string> {
    await this.navigateToChat(chatId, quiet);
    return refreshDR(this.page, { quiet, deadline });
  }

  async getDeepResearchResponse(): Promise<string> {
    return getDRResponse(this.page);
  }

  async waitForDeepResearchResponse(options: {
    timeout?: number;
    quiet?: boolean;
    skipStartPhase?: boolean;
    preActionText?: string;
  }): Promise<WaitForResponseResult> {
    return waitForDRResponse(this.page, options);
  }

  async copyDeepResearchContent(): Promise<string> {
    return copyDRContent(this.page);
  }

  async exportDeepResearch(
    format: DeepResearchExportFormat,
    savePath: string,
    quiet = false,
  ): Promise<string> {
    return exportDR(this.page, format, savePath, quiet);
  }

  // ── Chat management ────────────────────────────────────────

  async getConversationList(quiet = false): Promise<ConversationItem[]> {
    await this.waitForSidebarContainer(quiet);
    return this.page.locator(SELECTORS.CONVERSATION_LINK).evaluateAll((els, selector) =>
      els.reduce<{ id: string; title: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
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

  async getMostRecentChatId(quiet = false): Promise<{ chatId: string; href: string } | undefined> {
    await this.waitForSidebarContainer(quiet);
    const links = this.page.locator(SELECTORS.MOST_RECENT_CONVERSATION_LINK);
    if (await links.count() === 0) {
      return undefined;
    }

    const href = await links.first().getAttribute('href');
    if (!href) {
      throw new Error(
        `Recent conversation link is missing href (selector: ${SELECTORS.MOST_RECENT_CONVERSATION_LINK})`,
      );
    }

    const match = /\/c\/([^/?#]+)$/.exec(href);
    if (!match) {
      throw new Error(
        `Unexpected recent conversation href format: "${href}" (selector: ${SELECTORS.MOST_RECENT_CONVERSATION_LINK})`,
      );
    }
    return { chatId: match[1], href };
  }

  async deleteConversation(id: string, quiet = false): Promise<void> {
    progress(`Deleting conversation: ${id}`, quiet);
    const link = await this.openConversationMenu(id, quiet);
    await this.confirmDeleteAndWait(link);
    progress('Conversation deleted', quiet);
  }

  async archiveConversation(id: string, quiet = false): Promise<void> {
    progress(`Archiving conversation: ${id}`, quiet);
    const link = await this.openConversationMenu(id, quiet);

    await this.page.locator(SELECTORS.CONVERSATION_ARCHIVE_OPTION).click();

    await link.waitFor({ state: 'detached', timeout: 10_000 });
    progress('Conversation archived', quiet);
  }

  // ── Project management ─────────────────────────────────────

  async getProjectList(quiet = false): Promise<ProjectItem[]> {
    await this.waitForSidebarContainer(quiet);
    return this.page.locator(SELECTORS.PROJECT_LINK).evaluateAll((els) =>
      els.reduce<{ id: string; name: string; href: string }[]>((acc, el) => {
        const href = el.getAttribute('href');
        if (href) {
          const segments = href.split('/').filter(Boolean);
          if (segments[0] !== 'g' || segments.length < 3 || segments[2] !== 'project') {
            return acc;
          }
          acc.push({ id: segments[1], name: el.textContent.trim(), href });
        }
        return acc;
      }, []),
    );
  }

  async getProjectConversationList(quiet = false): Promise<ConversationItem[]> {
    await this.waitForReady();
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

  async deleteProjectConversation(id: string, quiet = false): Promise<void> {
    progress(`Deleting project conversation: ${id}`, quiet);
    const link = await this.openProjectConversationMenu(id);
    await this.confirmDeleteAndWait(link);
    progress('Project conversation deleted', quiet);
  }

  async createProject(name: string, quiet = false): Promise<void> {
    progress(`Creating project: ${name}`, quiet);

    await this.waitForSidebarContainer(quiet);

    const sectionToggle = this.page.locator(SELECTORS.PROJECT_SECTION_TOGGLE).first();
    const expanded = await sectionToggle.getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await sectionToggle.click();
    }

    const newBtn = this.page.locator(SELECTORS.NEW_PROJECT_BUTTON);
    await newBtn.waitFor({ state: 'visible', timeout: 5000 });
    await newBtn.click();

    const nameInput = this.page.locator(SELECTORS.PROJECT_NAME_INPUT);
    await nameInput.waitFor({ state: 'visible', timeout: 5000 });
    await nameInput.fill(name);

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

  // ── Attachments (delegated) ────────────────────────────────

  async attachGoogleDriveFile(fileName: string, quiet = false): Promise<void> {
    await attachGoogleDriveFileImpl(
      this.page,
      fileName,
      (lp, q) => this.openComposerMenuItem(lp, q),
      quiet,
    );
  }

  async attachGitHubRepo(repo: string, quiet = false): Promise<void> {
    await attachGitHubRepoImpl(
      this.page,
      repo,
      (lp, q) => this.openComposerMenuItem(lp, q),
      quiet,
    );
  }

  async enableAgentMode(quiet = false): Promise<void> {
    await enableAgentModeImpl(
      this.page,
      (lp, q) => this.openComposerMenuItem(lp, q),
      quiet,
    );
  }

  async attachFiles(filePaths: string[], quiet = false): Promise<void> {
    await attachFilesImpl(this.page, filePaths, quiet);
  }

  // ── Model & messaging ──────────────────────────────────────

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

  async waitForReady(timeout = 30_000): Promise<void> {
    await this.page.locator(SELECTORS.PROMPT_INPUT).waitFor({
      state: 'visible',
      timeout,
    });
  }

  async sendMessage(text: string): Promise<void> {
    await this.waitForReady();
    const input = this.page.locator(SELECTORS.PROMPT_INPUT);
    await input.fill(text);
    await this.page.locator(SELECTORS.SUBMIT_BUTTON).click();
  }

  async getAssistantMessageCount(): Promise<number> {
    return getAssistantMsgCount(this.page);
  }

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

    await this.page
      .locator(SELECTORS.THINKING_EFFORT_MENUITEM)
      .first()
      .waitFor({ state: 'visible' });

    const menuItem = await this.findMenuItemByLabels(candidates);
    await menuItem.click();

    progress(`Thinking effort set to: ${level}`, quiet);
  }

  async waitForResponse(options: WaitForResponseOptions): Promise<WaitForResponseResult> {
    return waitForResp(this.page, options);
  }

  async getLastResponse(): Promise<string> {
    return getLastResp(this.page);
  }

  // ── Reading ───────────────────────────────────────────────

  async readConversation(chatId: string, quiet = false): Promise<ConversationMessage[]> {
    await this.navigateToChat(chatId, quiet);

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

    const messages: ConversationMessage[] = [];
    for (const msg of rawMessages) {
      if (
        msg.role === 'assistant' &&
        messages.length > 0 &&
        messages[messages.length - 1].role === 'assistant'
      ) {
        messages[messages.length - 1] = msg;
      } else {
        messages.push(msg);
      }
    }

    progress(`Read ${String(messages.length)} message(s)`, quiet);
    return messages;
  }

  // ── Private ────────────────────────────────────────────────

  private async confirmDeleteAndWait(link: Locator): Promise<void> {
    await this.page.locator(SELECTORS.CONVERSATION_DELETE_OPTION).click();
    await this.page.locator(SELECTORS.CONVERSATION_DELETE_CONFIRM).click();
    await link.waitFor({ state: 'detached', timeout: 10_000 });
  }

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
}
