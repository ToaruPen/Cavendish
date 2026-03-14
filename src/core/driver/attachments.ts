/**
 * Attachment operations: Google Drive, GitHub, Agent Mode, file attach.
 *
 * All functions receive a Playwright Page and operate on it directly.
 * DOM selectors are sourced from constants/selectors.ts.
 */

import type { FrameLocator, Locator, Page } from 'playwright-core';

import { MENU_LABELS, SELECTORS } from '../../constants/selectors.js';
import { progress } from '../output-handler.js';

import { delay, isTimeoutError, SEND_BUTTON_TIMEOUT_MS, waitForReadySendButton } from './helpers.js';

type OpenMenuFn = (labelPath: (string | string[])[], quiet?: boolean) => Promise<void>;

// ── Google Drive ────────────────────────────────────────────

export async function attachGoogleDriveFile(
  page: Page,
  fileName: string,
  openComposerMenuItem: OpenMenuFn,
  quiet = false,
  sendButtonSelector: string = SELECTORS.SUBMIT_BUTTON,
  uploadTimeoutMs?: number,
): Promise<void> {
  progress(`Attaching Google Drive file: ${fileName}`, quiet);

  await openComposerMenuItem(
    [[...MENU_LABELS.ADD_FROM_GOOGLE_DRIVE]],
    quiet,
  );

  const pickerFrame = await waitForGooglePickerFrame(page);

  const searchInput = pickerFrame.locator(SELECTORS.GDRIVE_PICKER_SEARCH);
  await searchInput.waitFor({ state: 'visible', timeout: 10_000 });

  await searchInput.fill(fileName);
  await searchInput.press('Enter');

  await waitForPickerExactMatch(pickerFrame, fileName);

  const tileCountBefore = await page
    .locator(SELECTORS.FILE_ATTACHMENT_TILE)
    .count();

  const selectButton = pickerFrame.locator(SELECTORS.GDRIVE_PICKER_SELECT_BUTTON).first();
  await selectButton.click();

  await page.locator(SELECTORS.GDRIVE_PICKER_IFRAME).waitFor({
    state: 'detached',
    timeout: 10_000,
  });

  await waitForAttachmentTiles(page, tileCountBefore + 1, sendButtonSelector, uploadTimeoutMs);

  progress(`Google Drive file attached: ${fileName}`, quiet);
}

// ── GitHub ──────────────────────────────────────────────────

export async function attachGitHubRepo(
  page: Page,
  repo: string,
  openComposerMenuItem: OpenMenuFn,
  quiet = false,
): Promise<void> {
  progress(`Attaching GitHub repo: ${repo}`, quiet);

  const githubPill = page.locator(SELECTORS.GITHUB_FOOTER_BUTTON);
  const alreadyEnabled = await githubPill.isVisible();

  if (!alreadyEnabled) {
    await openComposerMenuItem(
      [[...MENU_LABELS.SHOW_MORE], ...MENU_LABELS.GITHUB],
      quiet,
    );
    await githubPill.waitFor({ state: 'visible', timeout: 5000 });
  }

  await githubPill.click();

  const repoSearch = page.locator(SELECTORS.GITHUB_REPO_SEARCH);
  await repoSearch.waitFor({ state: 'visible', timeout: 5000 });
  await repoSearch.fill(repo);

  const popover = page.locator(SELECTORS.POPOVER_CONTENT);
  const repoItem = popover.getByText(repo, { exact: true }).first();

  try {
    await repoItem.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      await page.keyboard.press('Escape');
      throw new Error(
        `GitHub repository "${repo}" not found in picker. Ensure the repo is registered in ChatGPT's GitHub app settings.`,
      );
    }
    throw error;
  }
  await repoItem.click();

  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'hidden', timeout: 5000 });

  progress(`GitHub repo attached: ${repo}`, quiet);
}

// ── Agent Mode ──────────────────────────────────────────────

export async function enableAgentMode(
  page: Page,
  openComposerMenuItem: OpenMenuFn,
  quiet = false,
): Promise<void> {
  progress('Enabling agent mode...', quiet);

  const pill = page.locator(SELECTORS.AGENT_MODE_PILL);
  const alreadyActive = await pill.isVisible();
  if (alreadyActive) {
    progress('Agent mode already active', quiet);
    return;
  }

  await openComposerMenuItem(
    [[...MENU_LABELS.SHOW_MORE], [...MENU_LABELS.AGENT_MODE]],
    quiet,
  );

  await pill.waitFor({ state: 'visible', timeout: 5000 });
  progress('Agent mode enabled', quiet);
}

// ── File attach ─────────────────────────────────────────────

export async function attachFiles(
  page: Page,
  filePaths: string[],
  quiet = false,
  sendButtonSelector: string = SELECTORS.SUBMIT_BUTTON,
  uploadTimeoutMs?: number,
): Promise<void> {
  progress(`Attaching ${String(filePaths.length)} file(s)...`, quiet);

  const tileCountBefore = await page.locator(SELECTORS.FILE_ATTACHMENT_TILE).count();
  const fileInput = page.locator(SELECTORS.FILE_INPUT_GENERIC);
  await fileInput.setInputFiles(filePaths);

  await waitForAttachmentTiles(page, tileCountBefore + filePaths.length, sendButtonSelector, uploadTimeoutMs);
  progress('Files attached', quiet);
}

// ── Shared helpers ──────────────────────────────────────────

export async function waitForAttachmentTiles(
  page: Page,
  expected: number,
  sendButtonSelector: string = SELECTORS.SUBMIT_BUTTON,
  uploadTimeoutMs?: number,
): Promise<void> {
  const effectiveTimeout = uploadTimeoutMs ?? SEND_BUTTON_TIMEOUT_MS;

  // Wait for the expected number of file tiles to appear in the composer.
  await page.waitForFunction(
    ({ selector, count }: { selector: string; count: number }) =>
      document.querySelectorAll(selector).length >= count,
    { selector: SELECTORS.FILE_ATTACHMENT_TILE, count: expected },
    { timeout: effectiveTimeout },
  );

  // Wait for upload completion: ChatGPT has used multiple send-button variants
  // in the composer, so accept any visible enabled send button.
  try {
    await waitForReadySendButton(page, sendButtonSelector, effectiveTimeout);
    await page.waitForFunction(
      (selector: string) => document.querySelectorAll(selector).length === 0,
      SELECTORS.UPLOAD_IN_PROGRESS,
      { timeout: effectiveTimeout },
    );
  } catch (err: unknown) {
    if (isTimeoutError(err)) {
      throw new Error(
        `Send button did not become enabled within ${String(Math.round(effectiveTimeout / 1000))}s after file upload. `
        + `Tried selectors: ${sendButtonSelector}, ${SELECTORS.SEND_BUTTON}, ${SELECTORS.SUBMIT_BUTTON}. `
        + `Pending upload selector: ${SELECTORS.UPLOAD_IN_PROGRESS}. `
        + 'The file may still be uploading or the composer UI may have changed.',
      );
    }
    throw err;
  }
}

async function waitForGooglePickerFrame(page: Page): Promise<FrameLocator> {
  try {
    await page.locator(SELECTORS.GDRIVE_PICKER_IFRAME).waitFor({
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
  return page.frameLocator(SELECTORS.GDRIVE_PICKER_IFRAME);
}

async function waitForPickerExactMatch(
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

    const match = await findExactPickerMatch(allResults, fileName);
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

async function findExactPickerMatch(
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
