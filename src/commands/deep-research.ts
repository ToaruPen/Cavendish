import { defineCommand } from 'citty';

import { errorMessage, fail, json, progress, text, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

import { buildPrompt, readStdin, validateFileArgs } from './ask.js';

const DEFAULT_TIMEOUT_SEC = 1800; // 30 minutes

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

      if (format === 'text') {
        text(result.text);
      } else {
        json(result.text, {
          model: 'deep-research',
          partial: !result.completed,
          timeoutSec,
        });
      }
    });
  },
});
