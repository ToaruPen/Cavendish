/**
 * Deep Research operations: navigation, send, wait phases, export, copy.
 *
 * All functions receive a Playwright Page and operate on it directly.
 * DOM selectors are sourced from constants/selectors.ts.
 */

import type { Frame, Page } from 'playwright';

import { CHATGPT_BASE_URL, SELECTORS } from '../../constants/selectors.js';
import type { DeepResearchExportFormat, WaitForResponseResult } from '../chatgpt-types.js';
import { progress } from '../output-handler.js';

import { DEFAULT_TIMEOUT_MS, computeIframeWaitDeadline, computePhaseDeadline, delay, isFrameDetachedError, isTimeoutError, POLL_INTERVAL_MS } from './helpers.js';

// ── Navigation ──────────────────────────────────────────────

export async function navigateToDeepResearch(page: Page, quiet = false): Promise<void> {
  progress('Opening Deep Research...', quiet);
  await page.goto(`${CHATGPT_BASE_URL}/deep-research`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator(SELECTORS.DEEP_RESEARCH_APP).waitFor({
    state: 'attached',
    timeout: 30_000,
  });
  await page.locator(SELECTORS.PROMPT_INPUT).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

// ── Send ────────────────────────────────────────────────────

export async function sendDeepResearchMessage(page: Page, text: string): Promise<void> {
  await page.locator(SELECTORS.PROMPT_INPUT).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  const input = page.locator(SELECTORS.PROMPT_INPUT);
  await input.fill(text);
  const sendBtn = page.locator(SELECTORS.SEND_BUTTON);
  await sendBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await sendBtn.click();
}

export async function sendDeepResearchFollowUp(
  page: Page,
  text: string,
  opts: { quiet?: boolean; deadline?: number },
): Promise<string> {
  const { quiet = false, deadline } = opts;

  await waitForDeepResearchFrame(page, deadline);

  const preActionText = await getDeepResearchResponse(page);

  const input = page.locator(SELECTORS.PROMPT_INPUT);
  await input.fill(text);

  const sendBtn = page.locator(SELECTORS.SEND_BUTTON_ENABLED);
  try {
    await sendBtn.waitFor({ state: 'visible', timeout: 5_000 });
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      throw new Error(
        `Send button not ready after entering follow-up text (selector: ${SELECTORS.SEND_BUTTON_ENABLED})`,
      );
    }
    throw e;
  }
  await sendBtn.click({ force: true });
  progress('Follow-up sent', quiet);
  return preActionText;
}

export async function refreshDeepResearch(
  page: Page,
  opts: { quiet?: boolean; deadline?: number },
): Promise<string> {
  const contentFrame = await waitForDeepResearchFrame(page, opts.deadline);

  const preActionText = await getDeepResearchResponse(page);

  const updateBtn = contentFrame.locator(SELECTORS.DEEP_RESEARCH_UPDATE_BUTTON);
  try {
    await updateBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      throw new Error(
        `Update button not found in DR iframe (selector: ${SELECTORS.DEEP_RESEARCH_UPDATE_BUTTON})`,
      );
    }
    throw e;
  }
  await updateBtn.first().scrollIntoViewIfNeeded();
  await updateBtn.first().click({ force: true });
  return preActionText;
}

// ── Response extraction ─────────────────────────────────────

export async function getDeepResearchResponse(page: Page): Promise<string> {
  const contentFrame = getDeepResearchContentFrame(page);
  if (!contentFrame) {
    return '';
  }
  try {
    return await contentFrame.evaluate(
      (selector: string) => {
        const root = document.querySelector(selector);
        if (root) {
          return root.textContent.trim();
        }
        return document.body.textContent.trim();
      },
      SELECTORS.DEEP_RESEARCH_REPORT_ROOT,
    );
  } catch (error: unknown) {
    if (isFrameDetachedError(error)) { return ''; }
    throw error;
  }
}

// ── Wait for completion ─────────────────────────────────────

export async function waitForDeepResearchResponse(
  page: Page,
  options: {
    timeout?: number;
    quiet?: boolean;
    skipStartPhase?: boolean;
    preActionText?: string;
  },
): Promise<WaitForResponseResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const quiet = options.quiet ?? false;
  const preActionText = options.preActionText ?? '';

  progress('Waiting for Deep Research response...', quiet);

  const deadline = Date.now() + timeout;

  // Phase 1: Wait for plan iframe and click "開始する"
  if (!options.skipStartPhase) {
    await clickDeepResearchStart(page, deadline, quiet);
  }

  // Phase 2: Wait for research to start (stop button appears in iframe).
  const STOP_DETECT_MS = 60_000;
  const stopDetectDeadline = computePhaseDeadline(Date.now(), deadline, STOP_DETECT_MS);
  let researchStarted = false;
  while (Date.now() < stopDetectDeadline) {
    await delay(POLL_INTERVAL_MS * 5);
    if (await hasDeepResearchStopButton(page)) {
      researchStarted = true;
      progress('Researching...', quiet);
      break;
    }
  }

  if (!researchStarted) {
    progress('Stop button not observed, checking for report...', quiet);
  }

  // Phase 3: Wait for research to complete (stop button disappears)
  if (researchStarted) {
    let lastLoggedAt = Date.now();
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS * 5);
      if (!await hasDeepResearchStopButton(page)) {
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
  return waitForDeepResearchReport(page, deadline, timeout, quiet, researchStarted, preActionText);
}

// ── Copy & export ───────────────────────────────────────────

export async function copyDeepResearchContent(page: Page): Promise<string> {
  const contentFrame = getDeepResearchContentFrame(page);
  if (!contentFrame) {
    throw new Error('Deep Research content frame not found');
  }

  // Save original clipboard text so we can restore it after the operation.
  // Uses clipboard.read() to detect non-text content (images, rich text):
  // Chromium's readText() resolves to '' for non-text items rather than
  // rejecting, so we must check item types to distinguish "empty text"
  // from "non-text content". Returns null when clipboard has no text/plain
  // item so the finally block skips restore and preserves the original data.
  // Clipboard API failures (e.g. permission denied) are caught separately
  // and logged as warnings — the copy operation proceeds without restore.
  let originalClipboard: string | null = null;
  let snapshotSucceeded = false;

  try {
    try {
      originalClipboard = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const hasText = items.some((item) => item.types.includes('text/plain'));
        if (!hasText) {
          return null;
        }
        return await navigator.clipboard.readText();
      });
      snapshotSucceeded = true;
    } catch (snapshotError: unknown) {
      const msg = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
      progress(`Warning: clipboard snapshot failed (${msg}). Original clipboard cannot be restored.`, false);
    }

    // Clear clipboard for copy-failure detection (readText returns '' if
    // the copy button didn't write anything).
    // Skip clear only when snapshot confirmed non-text content (images/files)
    // — in that case originalClipboard is null AND snapshot succeeded.
    if (originalClipboard !== null || !snapshotSucceeded) {
      await page.evaluate(() => navigator.clipboard.writeText(''));
    }

    await openDeepResearchExportMenu(contentFrame);

    const copyBtn = contentFrame.locator(SELECTORS.DEEP_RESEARCH_COPY_CONTENT);
    await copyBtn.click();
    await delay(POLL_INTERVAL_MS * 5);

    const copied = await page.evaluate(
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
  } finally {
    // Restore clipboard only if we successfully read original text content.
    // When originalClipboard is null (non-text data), skip restore to avoid
    // overwriting images/rich content with an empty string.
    if (originalClipboard !== null) {
      await page.evaluate(
        (text: string) => navigator.clipboard.writeText(text),
        originalClipboard,
      ).catch((restoreError: unknown) => {
        const msg = restoreError instanceof Error ? restoreError.message : String(restoreError);
        progress(`Warning: failed to restore clipboard (${msg}). Deep Research content may remain on clipboard.`, false);
      });
    }
  }
}

export async function exportDeepResearch(
  page: Page,
  format: DeepResearchExportFormat,
  savePath: string,
  quiet = false,
): Promise<string> {
  const contentFrame = getDeepResearchContentFrame(page);
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
    await openDeepResearchExportMenu(contentFrame);

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });

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

// ── Frame access (public for ChatGPTDriver facade) ──────────

export function getDeepResearchContentFrame(page: Page): Frame | undefined {
  const drFrames = page.frames().filter(
    (f) => f.url().includes(SELECTORS.DEEP_RESEARCH_FRAME_URL),
  );
  if (drFrames.length === 0) {
    return undefined;
  }
  const nested = drFrames[drFrames.length - 1].childFrames();
  return nested[0];
}

export async function waitForDeepResearchFrame(page: Page, deadline?: number): Promise<Frame> {
  const pollInterval = POLL_INTERVAL_MS * 5;
  const IFRAME_WAIT_DEFAULT_MS = 15_000;
  const effectiveDeadline = computeIframeWaitDeadline(Date.now(), deadline, IFRAME_WAIT_DEFAULT_MS);
  let attempts = 0;
  while (Date.now() < effectiveDeadline) {
    const frame = getDeepResearchContentFrame(page);
    if (frame) { return frame; }
    attempts++;
    await delay(pollInterval);
  }
  throw new Error(
    `Deep Research iframe not found after ${String(attempts)} attempts `
    + `(interval: ${String(pollInterval)}ms, url: ${page.url()}, `
    + `selector: ${SELECTORS.DEEP_RESEARCH_FRAME_URL})`,
  );
}

// ── Private helpers ─────────────────────────────────────────

async function hasDeepResearchStopButton(page: Page): Promise<boolean> {
  const contentFrame = getDeepResearchContentFrame(page);
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

async function clickDeepResearchStart(
  page: Page,
  deadline: number,
  quiet: boolean,
): Promise<void> {
  const START_PHASE_MS = 120_000;
  const startDeadline = computePhaseDeadline(Date.now(), deadline, START_PHASE_MS);
  while (Date.now() < startDeadline) {
    await delay(POLL_INTERVAL_MS * 5);

    if (await hasDeepResearchStopButton(page)) {
      progress('Research already started (auto-start)', quiet);
      return;
    }

    const contentFrame = getDeepResearchContentFrame(page);
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
    }
  }
  throw new Error(
    'Deep Research start not detected within timeout. ' +
    'Check ChatGPT Pro status or selector changes.',
  );
}

async function openDeepResearchExportMenu(contentFrame: Frame): Promise<void> {
  const exportBtn = contentFrame.locator(SELECTORS.DEEP_RESEARCH_EXPORT_BUTTON);
  await exportBtn.first().waitFor({ state: 'visible', timeout: 5_000 });
  await exportBtn.first().click();
  await delay(POLL_INTERVAL_MS * 5);
}

async function waitForDeepResearchReport(
  page: Page,
  deadline: number,
  timeout: number,
  quiet: boolean,
  seenStopButton: boolean,
  preActionText = '',
): Promise<WaitForResponseResult> {
  const initialText = await getDeepResearchResponse(page);

  // When seenStopButton is true, the research cycle (stop button appear → disappear) completed,
  // so any non-empty text is the final report — preActionText comparison is intentionally skipped.
  if (seenStopButton && initialText.length > 0 && !await hasDeepResearchStopButton(page)) {
    progress('Response complete', quiet);
    return { text: initialText, completed: true };
  }

  return pollForDeepResearchReport(page, deadline, timeout, quiet, seenStopButton, initialText, preActionText);
}

async function pollForDeepResearchReport(
  page: Page,
  deadline: number,
  timeout: number,
  quiet: boolean,
  seenStopButton: boolean,
  initialText: string,
  preActionText: string,
): Promise<WaitForResponseResult> {
  const STABLE_THRESHOLD = 3;
  let stableCount = 0;
  let sawTransition = false;

  // Use the overall deadline from the user's --timeout directly.
  // Previously a 120s hard cap was applied here, which could cut off
  // the report wait well before the user's timeout (e.g. --timeout 1800).
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS * 5);
    const hasStop = await hasDeepResearchStopButton(page);
    if (hasStop) {
      sawTransition = true;
      stableCount = 0;
      continue;
    }
    const text = await getDeepResearchResponse(page);
    if (text.length === 0) {
      sawTransition = true;
      stableCount = 0;
      continue;
    }
    if (text !== preActionText) {
      sawTransition = true;
    }
    if (!seenStopButton && !sawTransition && text === preActionText) {
      stableCount = 0;
      continue;
    }
    if (seenStopButton || text !== initialText) {
      progress('Response complete', quiet);
      return { text, completed: true };
    }
    stableCount++;
    if (stableCount >= STABLE_THRESHOLD) {
      progress('Response complete (stable)', quiet);
      return { text, completed: true };
    }
  }

  const partial = await getDeepResearchResponse(page);
  progress(`Timed out after ${String(timeout)}ms — returning partial response`, quiet);
  return { text: partial, completed: false };
}
