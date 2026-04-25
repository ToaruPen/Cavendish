/**
 * Deep Research operations: navigation, send, wait phases, export, copy.
 *
 * All functions receive a Playwright Page and operate on it directly.
 * DOM selectors are sourced from constants/selectors.ts.
 */

import type { Frame, Page } from 'playwright-core';

import { CHATGPT_BASE_URL, SELECTORS } from '../../constants/selectors.js';
import type { DeepResearchExportFormat, WaitForResponseResult } from '../chatgpt-types.js';
import { progress } from '../output-handler.js';
import { registerCleanup } from '../shutdown.js';

import { DEFAULT_TIMEOUT_MS, clickReadySendButton, computeIframeWaitDeadline, computePhaseDeadline, delay, isFrameDetachedError, isTimeoutError, POLL_INTERVAL_MS } from './helpers.js';

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

/**
 * Snapshot of iframe state captured immediately before a DR action so the
 * wait logic can disambiguate stale UI from fresh signals.  `hasExport` is
 * key for follow-ups: the previous report's export button is typically
 * visible on entry, so we initialise the polling state to "transition not
 * yet observed" and require seeing the export button absent during polling
 * before treating any later visible-export as completion.
 */
export interface DeepResearchPreActionState {
  text: string;
  hasExport: boolean;
}

async function snapshotPreActionState(page: Page): Promise<DeepResearchPreActionState> {
  const [text, hasExport] = await Promise.all([
    getDeepResearchResponse(page),
    hasDeepResearchExportButton(page),
  ]);
  return { text, hasExport };
}

export async function sendDeepResearchFollowUp(
  page: Page,
  text: string,
  opts: { quiet?: boolean; deadline?: number },
): Promise<DeepResearchPreActionState> {
  const { quiet = false, deadline } = opts;

  await waitForDeepResearchFrame(page, deadline);

  const preAction = await snapshotPreActionState(page);

  const input = page.locator(SELECTORS.PROMPT_INPUT);
  await input.fill(text);

  // Reuse the regular-chat send-button helper which checks width/height,
  // disabled, and aria-disabled before clicking.  The previous implementation
  // hand-rolled `:not([disabled])` + `force: true`, which silently no-op'd
  // when the button was still aria-disabled (React enable not yet flushed).
  try {
    await clickReadySendButton(page, SELECTORS.SEND_BUTTON_ENABLED, 5_000);
  } catch (e: unknown) {
    if (isTimeoutError(e)) {
      throw new Error(
        `Send button not ready after entering follow-up text (selector: ${SELECTORS.SEND_BUTTON_ENABLED})`,
      );
    }
    throw e;
  }
  progress('Follow-up sent', quiet);
  return preAction;
}

export async function refreshDeepResearch(
  page: Page,
  opts: { quiet?: boolean; deadline?: number },
): Promise<DeepResearchPreActionState> {
  const contentFrame = await waitForDeepResearchFrame(page, opts.deadline);

  const preAction = await snapshotPreActionState(page);

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
  return preAction;
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
        // Only extract text from the designated report root (<main>).
        // Falling back to document.body would include button labels,
        // animated counters, and other UI noise.
        return root ? root.textContent.trim() : '';
      },
      SELECTORS.DEEP_RESEARCH_REPORT_ROOT,
    );
  } catch (error: unknown) {
    if (isFrameDetachedError(error)) { return ''; }
    throw error;
  }
}

// ── Wait for completion ─────────────────────────────────────

/** Result of the stop-detect phase. */
interface StopDetectResult {
  researchStarted: boolean;
  exportAbsentObserved: boolean;
}

async function detectResearchStart(
  page: Page,
  deadline: number,
  quiet: boolean,
  initialExportAbsentObserved: boolean,
): Promise<StopDetectResult> {
  // Phase 2: Wait for research to start (stop button appears in iframe).
  // While we wait, also watch for the export button transitioning to absent;
  // a follow-up whose research finishes inside this window may never expose
  // the stop button to phase 4 polling, but the export disappearance still
  // marks a confirmed fresh-completion signal.
  const STOP_DETECT_MS = 60_000;
  const stopDetectDeadline = computePhaseDeadline(Date.now(), deadline, STOP_DETECT_MS);
  let exportAbsentObserved = initialExportAbsentObserved;
  while (Date.now() < stopDetectDeadline) {
    await delay(POLL_INTERVAL_MS * 5);
    const [stopVisible, exportVisible] = await Promise.all([
      hasDeepResearchStopButton(page),
      exportAbsentObserved ? Promise.resolve(true) : hasDeepResearchExportButton(page),
    ]);
    if (stopVisible) {
      progress('Researching...', quiet);
      return { researchStarted: true, exportAbsentObserved: true };
    }
    if (!exportVisible) {
      exportAbsentObserved = true;
    }
  }
  progress('Stop button not observed, checking for report...', quiet);
  return { researchStarted: false, exportAbsentObserved };
}

async function waitForResearchEnd(page: Page, deadline: number, quiet: boolean): Promise<void> {
  let lastLoggedAt = Date.now();
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS * 5);
    if (!await hasDeepResearchStopButton(page)) {
      progress('Research phase complete, waiting for report...', quiet);
      return;
    }
    const now = Date.now();
    if (now - lastLoggedAt > 30_000) {
      progress('Still researching...', quiet);
      lastLoggedAt = now;
    }
  }
}

export async function waitForDeepResearchResponse(
  page: Page,
  options: {
    timeout?: number;
    quiet?: boolean;
    skipStartPhase?: boolean;
    preAction?: DeepResearchPreActionState;
  },
): Promise<WaitForResponseResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const quiet = options.quiet ?? false;
  const preActionText = options.preAction?.text ?? '';
  const preActionHasExport = options.preAction?.hasExport ?? false;

  progress('Waiting for Deep Research response...', quiet);

  const deadline = Date.now() + timeout;

  // Phase 1: Wait for plan iframe and click "開始する"
  if (!options.skipStartPhase) {
    await clickDeepResearchStart(page, deadline, quiet);
  }

  // Phase 2: Wait for research to start.
  const { researchStarted, exportAbsentObserved } = await detectResearchStart(
    page,
    deadline,
    quiet,
    !preActionHasExport,
  );

  // Phase 3: Wait for research to complete (stop button disappears).
  if (researchStarted) {
    await waitForResearchEnd(page, deadline, quiet);
  }

  // Phase 4: Wait for the final report to render.
  return waitForDeepResearchReport(page, deadline, timeout, quiet, researchStarted, preActionText, exportAbsentObserved);
}

// ── Copy & export ───────────────────────────────────────────

export async function copyDeepResearchContent(page: Page): Promise<string> {
  const contentFrame = getDeepResearchContentFrame(page);
  if (!contentFrame) {
    throw new Error('Deep Research content frame not found');
  }

  // Save original clipboard contents (all MIME types) so we can restore them.
  // Uses clipboard.read() to serialize each ClipboardItem's representations
  // as base64 strings, enabling full restoration of text, images, and mixed
  // content. Returns empty array for empty clipboard (restore clears it).
  // Throws on API failure to avoid irreversible clipboard destruction.
  let clipboardSnapshot: Record<string, string>[] | null = null;
  let unregisterCleanup: (() => void) | null = null;

  try {
    try {
      clipboardSnapshot = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const serialized: Record<string, string>[] = [];
        for (const item of items) {
          const representations: Record<string, string> = {};
          for (const type of item.types) {
            const blob = await item.getType(type);
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const chunks: string[] = [];
            for (let i = 0; i < bytes.length; i += 8192) {
              chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
            }
            representations[type] = btoa(chunks.join(''));
          }
          serialized.push(representations);
        }
        return serialized;
      });
    } catch (snapshotError: unknown) {
      const msg = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
      throw new Error(
        `Failed to snapshot clipboard before copy (${msg}). `
        + 'Aborting to preserve existing clipboard. Use --export markdown to download the report instead.',
      );
    }

    // Register signal cleanup so SIGINT/SIGTERM restores clipboard before exit.
    // The finally block unregisters this since normal flow handles its own restore.
    const snapshot = clipboardSnapshot;
    unregisterCleanup = registerCleanup(() => restoreClipboard(page, snapshot));

    // Clear clipboard so we can detect copy-button failure (empty → not updated).
    // clipboardSnapshot is guaranteed non-null here because snapshot failure throws above.
    await page.evaluate(() => navigator.clipboard.writeText(''));

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
    // Restore the original clipboard. The operation above (menu open → copy click
    // → readText) takes ~2-3s, so the risk of user-initiated clipboard changes
    // between snapshot and restore is negligible; unconditional restore is acceptable.
    //
    // IMPORTANT: unregister the signal cleanup AFTER restore completes, not before.
    // If a signal arrives during restore, the cleanup callback is still registered
    // and runCleanupCallbacks() will also attempt restore (harmless double-call
    // since restoreClipboard has a .catch()). Unregistering first would create a
    // race window where a signal could fire with no cleanup registered.
    if (clipboardSnapshot !== null) {
      await restoreClipboard(page, clipboardSnapshot);
    }
    if (unregisterCleanup) {
      unregisterCleanup();
    }
  }
}

/**
 * Restore clipboard from a previously captured snapshot.
 * Shared between the normal finally-block path and the signal cleanup path.
 */
async function restoreClipboard(
  page: Page,
  snapshot: Record<string, string>[],
): Promise<void> {
  await page.evaluate(async (snap: Record<string, string>[]) => {
    // No items or all items have only empty representations → write empty text.
    // Chrome rejects ClipboardItem with zero-byte Blobs ("Empty dictionary argument"),
    // so we fall back to writeText('') for clipboards that had no meaningful content.
    const hasContent = snap.some((reps) =>
      Object.values(reps).some((b64) => b64.length > 0),
    );
    if (snap.length === 0 || !hasContent) {
      await navigator.clipboard.writeText('');
      return;
    }
    const items = snap.map((representations) => {
      const blobMap: Record<string, Blob> = {};
      for (const [type, base64] of Object.entries(representations)) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        blobMap[type] = new Blob([bytes], { type });
      }
      return new ClipboardItem(blobMap);
    });
    await navigator.clipboard.write(items);
  }, snapshot).catch((restoreError: unknown) => {
    const msg = restoreError instanceof Error ? restoreError.message : String(restoreError);
    progress(`Warning: failed to restore clipboard (${msg}). Deep Research content may remain on clipboard.`, false);
  });
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

function getDeepResearchContentFrame(page: Page): Frame | undefined {
  const drFrames = page.frames().filter(
    (f) => f.url().includes(SELECTORS.DEEP_RESEARCH_FRAME_URL),
  );
  if (drFrames.length === 0) {
    return undefined;
  }
  const nested = drFrames[drFrames.length - 1].childFrames();
  return nested[0];
}

async function waitForDeepResearchFrame(page: Page, deadline?: number): Promise<Frame> {
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

async function hasVisibleDRControl(page: Page, selector: string): Promise<boolean> {
  const contentFrame = getDeepResearchContentFrame(page);
  if (!contentFrame) {
    return false;
  }
  try {
    const locator = contentFrame.locator(selector);
    const count = await locator.count();
    // Visibility check matters: the stop button can linger in the DOM
    // (hidden) after research completes, and the export button only
    // becomes visible once the final report is rendered.  A `count() > 0`
    // check is not enough.  Iterate over all matches so a hidden stale
    // element earlier in the DOM does not mask a later visible control.
    for (let i = 0; i < count; i++) {
      if (await locator.nth(i).isVisible()) {
        return true;
      }
    }
    return false;
  } catch (error: unknown) {
    if (isFrameDetachedError(error)) { return false; }
    throw error;
  }
}

async function hasDeepResearchStopButton(page: Page): Promise<boolean> {
  return hasVisibleDRControl(page, SELECTORS.DEEP_RESEARCH_STOP_BUTTON);
}

async function hasDeepResearchExportButton(page: Page): Promise<boolean> {
  return hasVisibleDRControl(page, SELECTORS.DEEP_RESEARCH_EXPORT_BUTTON);
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
  preActionText: string,
  exportAbsentObserved: boolean,
): Promise<WaitForResponseResult> {
  const initialText = await getDeepResearchResponse(page);

  // When seenStopButton is true, the research cycle (stop button appear → disappear) completed,
  // so any non-empty text that differs from preActionText is the final report.
  // The preActionText guard prevents returning the old report on follow-up/refresh.
  if (seenStopButton && initialText.length > 0 && initialText !== preActionText && !await hasDeepResearchStopButton(page)) {
    progress('Response complete', quiet);
    return { text: initialText, completed: true };
  }

  return pollForDeepResearchReport(page, deadline, timeout, quiet, seenStopButton, preActionText, exportAbsentObserved);
}

export interface ReportPollState {
  /**
   * True once `hasExport=false` has been observed since the action was sent
   * (during the detect window, the research-end wait, or polling).  The
   * export button is part of the final-report UI, so a confirmed absence is
   * the only reliable proof that any later `hasExport=true` reflects a
   * freshly rendered report rather than a stale button from the previous run.
   */
  exportObservedAbsent: boolean;
}

/**
 * Evaluate a single poll iteration for DR report readiness.
 *
 * Completion is gated on one of:
 *   1. The export button is visible AND `state.exportObservedAbsent` is
 *      true — only the final report exposes the export menu, and the
 *      observed-absent flag confirms the signal is fresh.
 *   2. The stop button cycle (`seenStopButton` true) completed and text
 *      now differs from `preActionText` — the cycle "stop button appeared
 *      then disappeared" only completes once the final report has rendered.
 *
 * @returns The final report text if complete, or `null` to keep polling.
 */
export function evaluateReportPoll(
  text: string,
  hasStop: boolean,
  hasExport: boolean,
  seenStopButton: boolean,
  preActionText: string,
  state: ReportPollState,
): string | null {
  if (!hasExport) {
    state.exportObservedAbsent = true;
  }
  if (hasStop || text.length === 0) {
    return null;
  }
  if (hasExport && state.exportObservedAbsent) {
    return text;
  }
  if (seenStopButton && text !== preActionText) {
    return text;
  }
  return null;
}

async function pollForDeepResearchReport(
  page: Page,
  deadline: number,
  timeout: number,
  quiet: boolean,
  seenStopButton: boolean,
  preActionText: string,
  exportAbsentObserved: boolean,
): Promise<WaitForResponseResult> {
  const state: ReportPollState = { exportObservedAbsent: exportAbsentObserved };

  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS * 5);
    const hasStop = await hasDeepResearchStopButton(page);
    const [hasExport, text] = hasStop
      ? [false, '']
      : await Promise.all([hasDeepResearchExportButton(page), getDeepResearchResponse(page)]);
    const result = evaluateReportPoll(text, hasStop, hasExport, seenStopButton, preActionText, state);
    if (result !== null) {
      progress('Response complete', quiet);
      return { text: result, completed: true };
    }
  }

  const partial = await getDeepResearchResponse(page);
  progress(`Timed out after ${String(timeout)}ms — returning partial response`, quiet);
  return { text: partial, completed: false };
}
