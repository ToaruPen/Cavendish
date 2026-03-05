import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import { BrowserManager } from '../core/browser-manager.js';
import { ChatGPTDriver } from '../core/chatgpt-driver.js';
import { json, progress, text } from '../core/output-handler.js';

const DEFAULT_MODEL = 'Pro';
const DEFAULT_TIMEOUT_SEC = 120;
const PRO_TIMEOUT_SEC = 2400;

/**
 * Read piped stdin when running in a non-TTY context.
 * Returns the trimmed input, or an empty string when stdin is a TTY.
 */
export function readStdin(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  try {
    return readFileSync(0, 'utf-8').trim();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    progress(`Warning: failed to read stdin: ${detail}`, false);
    return '';
  }
}

/**
 * Combine optional stdin data with the user-supplied prompt.
 * When stdin data is present, it is prepended with a blank-line separator.
 */
export function buildPrompt(prompt: string, stdinData: string): string {
  if (stdinData === '') {
    return prompt;
  }
  return `${stdinData}\n\n${prompt}`;
}

/**
 * Extract --file arguments from process.argv.
 * citty does not support array-type args, so we parse manually.
 * Returns resolved absolute paths.
 */
export function extractFileArgs(argv: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') {break;} // respect end-of-options
    if (argv[i] === '--file' && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value.startsWith('-')) {
        throw new Error(`--file requires a file path, got "${value}"`);
      }
      files.push(resolve(value));
      i++; // skip the value
    }
  }
  return files;
}

/**
 * Validate that all file paths exist. Returns the first missing path,
 * or undefined if all exist.
 */
export function findMissingFile(filePaths: string[]): string | undefined {
  return filePaths.find((p) => !existsSync(p));
}

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
      description: 'Response timeout in seconds (model-dependent; default: 120, Pro: 2400)',
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
    file: {
      type: 'string',
      description: 'File(s) to attach (repeatable: --file a.ts --file b.ts)',
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

    let filePaths: string[];
    try {
      filePaths = extractFileArgs(process.argv);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      progress(`Error: ${detail}`, false);
      process.exitCode = 1;
      return;
    }
    const missingFile = findMissingFile(filePaths);
    if (missingFile !== undefined) {
      progress(`Error: file not found: ${missingFile}`, false);
      process.exitCode = 1;
      return;
    }

    const stdinData = readStdin();
    const prompt = buildPrompt(args.prompt, stdinData);

    const browser = new BrowserManager();

    try {
      const page = await browser.getPage(quiet);
      const driver = new ChatGPTDriver(page);

      await driver.selectModel(model, quiet);

      if (filePaths.length > 0) {
        await driver.attachFiles(filePaths, quiet);
      }

      progress('Sending message...', quiet);
      const initialMsgCount = await driver.getAssistantMessageCount();
      await driver.sendMessage(prompt);

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
