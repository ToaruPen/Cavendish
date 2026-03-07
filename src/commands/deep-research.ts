import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import type { DeepResearchExportFormat } from '../core/chatgpt-driver.js';
import { errorMessage, fail, json, progress, text, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

import { buildPrompt, readStdin, validateFileArgs } from './ask.js';

const DEFAULT_TIMEOUT_SEC = 1800; // 30 minutes

const VALID_EXPORT_FORMATS: readonly DeepResearchExportFormat[] = ['markdown', 'word', 'pdf'];

const EXPORT_EXTENSIONS: Record<DeepResearchExportFormat, string> = {
  markdown: '.md',
  word: '.docx',
  pdf: '.pdf',
};

function defaultExportFilename(format: DeepResearchExportFormat): string {
  return `deep-research-report${EXPORT_EXTENSIONS[format]}`;
}

/**
 * `cavendish deep-research` — send a prompt to ChatGPT Deep Research and return the report.
 */
export const deepResearchCommand = defineCommand({
  meta: {
    name: 'deep-research',
    description: 'Send a prompt to ChatGPT Deep Research and return the report',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'The prompt to send to Deep Research',
      required: true,
    },
    timeout: {
      type: 'string',
      description: `Response timeout in seconds (default: ${String(DEFAULT_TIMEOUT_SEC)})`,
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress stderr progress messages',
    },
    format: {
      type: 'string',
      description: 'Output format: json or text (default: json)',
      default: 'json',
    },
    file: {
      type: 'string',
      description: 'File(s) to attach (repeatable: --file a.ts --file b.ts)',
    },
    export: {
      type: 'string',
      description: 'Export report to file: markdown, word, or pdf (e.g. --export markdown)',
    },
    exportPath: {
      type: 'string',
      description: 'Path to save exported file (default: ./deep-research-report.{ext})',
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;

    const format = validateFormat(args.format);
    if (format === undefined) { return; }

    const timeoutSec = args.timeout !== undefined ? Number(args.timeout) : DEFAULT_TIMEOUT_SEC;
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      fail(`--timeout must be a positive number, got "${String(args.timeout)}"`);
      return;
    }
    const timeoutMs = timeoutSec * 1000;

    const exportFormat = args.export as DeepResearchExportFormat | undefined;
    if (exportFormat !== undefined && !VALID_EXPORT_FORMATS.includes(exportFormat)) {
      fail(`--export must be one of: ${VALID_EXPORT_FORMATS.join(', ')}. Got "${exportFormat}"`);
      return;
    }

    if (exportFormat === undefined && args.exportPath !== undefined) {
      fail('--exportPath requires --export (e.g. --export markdown --exportPath report.md)');
      return;
    }

    const filePaths = validateFileArgs();
    if (filePaths === undefined) { return; }

    let stdinData: string;
    try {
      stdinData = readStdin();
    } catch (error: unknown) {
      fail(errorMessage(error));
      return;
    }
    const prompt = buildPrompt(args.prompt, stdinData);

    await withDriver(quiet, async (driver) => {
      await driver.navigateToDeepResearch(quiet);

      if (filePaths.length > 0) {
        await driver.attachFiles(filePaths, quiet);
      }

      progress('Sending Deep Research query...', quiet);
      await driver.sendDeepResearchMessage(prompt);

      const result = await driver.waitForDeepResearchResponse({
        timeout: timeoutMs,
        quiet,
      });

      // Get clean Markdown text via copy-content when available (best-effort)
      let reportText = result.text;
      if (result.completed) {
        try {
          const markdown = await driver.copyDeepResearchContent();
          if (markdown.length > 0) {
            reportText = markdown;
          }
        } catch (error: unknown) {
          // Copy-content is optional; fall back to raw extracted text.
          // Failures include clipboard permission errors, selector
          // timeouts (locale mismatch), and frame detachment.
          progress(`Copy content failed, using raw text: ${errorMessage(error)}`, quiet);
        }
      }

      // Export to file if requested (after copy, so export menu state is clean)
      if (exportFormat !== undefined) {
        if (!result.completed) {
          const target = args.exportPath ?? defaultExportFilename(exportFormat);
          fail(`--export requested but report is incomplete; export to "${target}" aborted`);
          return;
        }
        const savePath = resolve(args.exportPath ?? defaultExportFilename(exportFormat));
        await driver.exportDeepResearch(exportFormat, savePath, quiet);
      }

      if (format === 'text') {
        text(reportText);
      } else {
        json(reportText, {
          model: 'deep-research',
          partial: !result.completed,
          timeoutSec,
        });
      }
    });
  },
});
