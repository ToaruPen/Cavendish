import { defineCommand } from 'citty';

import { fail, json, progress, text, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

import { extractArgsOrFail } from './ask.js';

const DEFAULT_TIMEOUT_SEC = 1800; // 30 minutes

/**
 * `cavendish deep-research` — send a prompt to Deep Research and return the report.
 */
export const deepResearchCommand = defineCommand({
  meta: {
    name: 'deep-research',
    description: 'Send a prompt to ChatGPT Deep Research and return the report',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'The research prompt',
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
    github: {
      type: 'string',
      description: 'GitHub repo(s) as context (repeatable: --github "owner/repo")',
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const format = validateFormat(args.format);
    if (format === undefined) { return; }

    const timeoutSec = args.timeout !== undefined
      ? Number(args.timeout)
      : DEFAULT_TIMEOUT_SEC;

    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      fail(`--timeout must be a positive number, got "${String(args.timeout)}"`);
      return;
    }

    const githubRepos = extractArgsOrFail('github');
    if (githubRepos === undefined) { return; }

    const timeoutMs = timeoutSec * 1000;
    const prompt = args.prompt;

    await withDriver(quiet, async (driver) => {
      await driver.navigateToDeepResearch(quiet);

      for (const repo of githubRepos) {
        await driver.attachGitHubRepo(repo, quiet);
      }

      progress('Sending Deep Research prompt...', quiet);
      const initialMsgCount = await driver.getAssistantMessageCount();
      await driver.sendDeepResearch(prompt, quiet);

      const result = await driver.waitForResponse({
        timeout: timeoutMs,
        quiet,
        initialMsgCount,
        label: 'Deep Research',
      });

      if (format === 'text') {
        text(result.text);
      } else {
        json(result.text, {
          partial: !result.completed,
          model: 'deep-research',
          timeoutSec,
        });
      }
    });
  },
});
