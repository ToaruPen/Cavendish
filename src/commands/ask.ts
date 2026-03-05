import { defineCommand } from 'citty';

import { BrowserManager } from '../core/browser-manager.js';
import { ChatGPTDriver } from '../core/chatgpt-driver.js';
import { json, progress, text } from '../core/output-handler.js';

const DEFAULT_MODEL = 'Pro';
const DEFAULT_TIMEOUT_SEC = 120;
const PRO_TIMEOUT_SEC = 2400;

/**
 * Resolve the effective timeout: use explicit --timeout if provided,
 * otherwise pick a model-appropriate default.
 */
function resolveTimeoutSec(
  explicitTimeout: string | undefined,
  model: string,
): number {
  if (explicitTimeout !== undefined) {
    return Number(explicitTimeout);
  }
  return model.toLowerCase().includes('pro') ? PRO_TIMEOUT_SEC : DEFAULT_TIMEOUT_SEC;
}

/**
 * `cavendish ask` — send a prompt to ChatGPT and return the response.
 */
export const askCommand = defineCommand({
  meta: {
    name: 'ask',
    description: 'Send a prompt to ChatGPT and return the response',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'The prompt to send to ChatGPT',
      required: true,
    },
    timeout: {
      type: 'string',
      description: 'Response timeout in seconds (default: 120, Pro: 2400)',
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
    model: {
      type: 'string',
      description: 'ChatGPT model to use (default: Pro)',
      default: DEFAULT_MODEL,
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const model = args.model;
    const timeoutSec = resolveTimeoutSec(args.timeout, model);

    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      progress(`Error: --timeout must be a positive number, got "${String(args.timeout)}"`, false);
      process.exitCode = 1;
      return;
    }
    const timeoutMs = timeoutSec * 1000;

    if (args.format !== 'json' && args.format !== 'text') {
      progress(`Error: --format must be "json" or "text", got "${args.format}"`, false);
      process.exitCode = 1;
      return;
    }
    const format = args.format;

    const browser = new BrowserManager();

    try {
      const page = await browser.getPage(quiet);
      const driver = new ChatGPTDriver(page);

      await driver.selectModel(model, quiet);

      progress('Sending message...', quiet);
      const initialMsgCount = await driver.getAssistantMessageCount();
      await driver.sendMessage(args.prompt);

      const result = await driver.waitForResponse({
        timeout: timeoutMs,
        quiet,
        initialMsgCount,
      });

      if (format === 'text') {
        text(result.text);
      } else {
        json(result.text, { partial: !result.completed, model, timeoutSec });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      progress(`Error: ${message}`, false);
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  },
});
