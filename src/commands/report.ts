/**
 * `cavendish report` — validate selectors against live ChatGPT DOM,
 * capture DOM structure, compare with baseline, and optionally create
 * a GitHub issue when breakage is detected.
 */

import { defineCommand } from 'citty';
import type { Page } from 'playwright-core';

import { CHATGPT_BASE_URL } from '../constants/selectors.js';
import { BrowserManager } from '../core/browser-manager.js';
import { GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { failStructured, jsonRaw, progress, text } from '../core/output-handler.js';
import { acquireLock, releaseLock } from '../core/process-lock.js';
import {
  DOM_SNAPSHOT_FILE,
  type DomSnapshot,
  type ReportResult,
  SNAPSHOT_VERSION,
  captureDomStructure,
  collectEnvironment,
  compareWithBaseline,
  createGitHubIssue,
  determineBroken,
  formatReportText,
  loadBaseline,
  saveBaseline,
  validateAllSelectors,
} from '../core/report.js';

const REPORT_ARGS = {
  ...GLOBAL_ARGS,
  format: {
    type: 'string' as const,
    description: 'Output format: json or text (default: text)',
    default: 'text',
  },
  saveBaseline: {
    type: 'boolean' as const,
    description: 'Save current DOM state as baseline for future comparisons',
  },
  issue: {
    type: 'boolean' as const,
    description: 'Create a GitHub issue when broken selectors are detected (requires gh CLI)',
  },
};

/** Navigate to ChatGPT if the page is on a non-interactive URL. */
async function ensureChatGptPage(page: Page, quiet: boolean): Promise<void> {
  const pageUrl = page.url();
  const isNonInteractive =
    !pageUrl.startsWith(CHATGPT_BASE_URL)
    || pageUrl.includes('/share/')
    || pageUrl.includes('/auth/');
  if (isNonInteractive) {
    progress('Navigating to ChatGPT...', quiet);
    await page.goto(CHATGPT_BASE_URL, { waitUntil: 'domcontentloaded' });
  }
}

/** Build a ReportResult from page data and an optional baseline. */
async function buildReport(page: Page, quiet: boolean): Promise<ReportResult> {
  const [selectors, structure, environment] = await Promise.all([
    validateAllSelectors(page, quiet),
    captureDomStructure(page, quiet),
    collectEnvironment(page),
  ]);

  const baseline = loadBaseline();
  const comparison = baseline
    ? compareWithBaseline(selectors, baseline)
    : null;

  const broken = determineBroken(selectors, comparison);

  return { selectors, broken, structure, baseline: comparison, environment };
}

export const reportCommand = defineCommand({
  meta: {
    name: 'report',
    description: 'Validate selectors against live ChatGPT DOM and detect UI changes',
  },
  args: REPORT_ARGS,
  async run({ args }): Promise<void> {
    const format = args.format === 'json' ? 'json' : 'text';
    if (!rejectUnknownFlags(REPORT_ARGS, format)) { return; }

    if (args.dryRun === true) {
      progress('[dry-run] Would validate selectors and capture DOM structure', false);
      return;
    }

    const quiet = args.quiet === true;
    const browser = new BrowserManager();
    try {
      acquireLock();
      progress('Connecting to Chrome...', quiet);
      await browser.connect(quiet);
      const page = await browser.getPage(quiet);

      await ensureChatGptPage(page, quiet);
      const result = await buildReport(page, quiet);

      // Output
      if (format === 'json') {
        jsonRaw(result);
      } else {
        for (const line of formatReportText(result)) {
          text(line);
        }
      }

      // Save baseline when requested
      if (args.saveBaseline === true) {
        const snapshot: DomSnapshot = {
          version: SNAPSHOT_VERSION,
          timestamp: result.environment.timestamp,
          selectors: result.selectors,
          structure: result.structure,
          environment: result.environment,
        };
        saveBaseline(snapshot);
        progress('Baseline saved to ' + DOM_SNAPSHOT_FILE, quiet);
      }

      // Create GitHub issue when broken selectors exist
      if (args.issue === true && result.broken.length > 0) {
        createGitHubIssue(result, quiet);
      } else if (args.issue === true) {
        progress('No broken selectors detected — skipping issue creation', quiet);
      }

      if (result.broken.length > 0) {
        process.exitCode = 1;
      }
    } catch (error: unknown) {
      failStructured(error, format);
    } finally {
      try {
        try {
          await browser.closePage();
        } finally {
          await browser.close();
        }
      } finally {
        releaseLock();
      }
    }
  },
});
