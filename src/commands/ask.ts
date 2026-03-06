import { fstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import { BrowserManager } from '../core/browser-manager.js';
import { ChatGPTDriver, type ThinkingEffortLevel } from '../core/chatgpt-driver.js';
import { errorMessage, fail, json, progress, text, validateFormat } from '../core/output-handler.js';

const VALID_THINKING_EFFORTS: readonly ThinkingEffortLevel[] = [
  'light', 'standard', 'extended', 'deep',
];

/** Pro models only allow standard and extended effort levels. */
const PRO_THINKING_EFFORTS: readonly ThinkingEffortLevel[] = ['standard', 'extended'];

/**
 * Return the allowed thinking effort levels for a model, or undefined
 * if the model does not support --thinking-effort at all.
 */
function allowedThinkingEfforts(model: string): readonly ThinkingEffortLevel[] | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('thinking')) {return VALID_THINKING_EFFORTS;}
  if (lower.includes('pro')) {return PRO_THINKING_EFFORTS;}
  return undefined;
}

const DEFAULT_MODEL = 'Pro';
const DEFAULT_TIMEOUT_SEC = 120;
const PRO_TIMEOUT_SEC = 2400;

/**
 * Read piped stdin when running in a non-TTY context.
 * Returns the raw input, or an empty string when stdin is a TTY.
 */
export function readStdin(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  try {
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile()) {
      return '';
    }
    return readFileSync(0, 'utf-8');
  } catch (error: unknown) {
    throw new Error(
      `Failed to read piped stdin: ${errorMessage(error)}. Re-run without pipe or fix stdin source.`,
    );
  }
}

/**
 * Combine optional stdin data with the user-supplied prompt.
 * When stdin data is present, it is prepended with a blank-line separator.
 */
export function buildPrompt(prompt: string, stdinData: string): string {
  if (stdinData.length === 0) {
    return prompt;
  }
  return `${stdinData}\n\n${prompt}`;
}

/**
 * Extract --file arguments from process.argv.
 * citty does not support array-type args, so we parse manually.
 * Supports both --file <path> and --file=<path> forms.
 * Returns resolved absolute paths.
 */
export function extractFileArgs(argv: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') {break;} // respect end-of-options
    if (argv[i].startsWith('--file=')) {
      const value = argv[i].slice('--file='.length);
      if (value === '') {
        throw new Error('--file requires a file path');
      }
      files.push(resolve(value));
    } else if (argv[i] === '--file') {
      if (i + 1 >= argv.length) {
        throw new Error('--file requires a file path');
      }
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
 * Validate that all file paths exist and are regular files.
 * Returns the first invalid path, or undefined if all are valid.
 */
export function findMissingFile(filePaths: string[]): string | undefined {
  return filePaths.find((p) => {
    try {
      return !statSync(p).isFile();
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {return true;}
      throw new Error(`Failed to stat "${p}": ${errorMessage(error)}`);
    }
  });
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

interface ValidatedArgs {
  quiet: boolean;
  model: string;
  timeoutMs: number;
  timeoutSec: number;
  format: 'json' | 'text';
  filePaths: string[];
  thinkingEffort: ThinkingEffortLevel | undefined;
  prompt: string;
  continueChat: boolean;
  chatId: string | undefined;
  project: string | undefined;
}

/**
 * Validate --thinking-effort against the model's allowed levels.
 * Returns an error message string on failure, or undefined on success.
 */
function validateThinkingEffort(
  thinkingEffort: ThinkingEffortLevel | undefined,
  model: string,
): string | undefined {
  if (thinkingEffort === undefined) {
    return undefined;
  }
  if (!VALID_THINKING_EFFORTS.includes(thinkingEffort)) {
    return `--thinking-effort must be one of: ${VALID_THINKING_EFFORTS.join(', ')}. Got "${thinkingEffort}"`;
  }
  const allowedEfforts = allowedThinkingEfforts(model);
  if (allowedEfforts === undefined) {
    return `--thinking-effort is not supported for model "${model}". Use Thinking or Pro models.`;
  }
  if (!allowedEfforts.includes(thinkingEffort)) {
    return `--thinking-effort "${thinkingEffort}" is not valid for model "${model}". Allowed: ${allowedEfforts.join(', ')}`;
  }
  return undefined;
}

/** Validate file-related args (--file). Returns file paths or undefined on error. */
function validateFileArgs(): string[] | undefined {
  let filePaths: string[];
  try {
    filePaths = extractFileArgs(process.argv);
  } catch (error: unknown) {
    fail(errorMessage(error));
    return undefined;
  }

  let missingFile: string | undefined;
  try {
    missingFile = findMissingFile(filePaths);
  } catch (error: unknown) {
    fail(errorMessage(error));
    return undefined;
  }
  if (missingFile !== undefined) {
    fail(`file not found or not a regular file: ${missingFile}`);
    return undefined;
  }

  return filePaths;
}

/** Validate --continue / --chat / --project mutual-exclusion rules. */
function validateChatOptions(
  args: Record<string, unknown>,
): { continueChat: boolean; chatId: string | undefined; project: string | undefined } | undefined {
  const continueChat = args.continue === true;
  const chatId = args.chat as string | undefined;
  const project = args.project as string | undefined;

  if (chatId !== undefined && !continueChat) {
    fail('--chat requires --continue. Use: cavendish ask --continue --chat <id> "prompt"');
    return undefined;
  }
  if (continueChat && project !== undefined) {
    fail('--continue and --project cannot be used together.');
    return undefined;
  }
  return { continueChat, chatId, project };
}

/**
 * Parse and validate all CLI arguments. Returns undefined on validation failure
 * (exitCode is set and error is logged).
 */
function validateArgs(args: Record<string, unknown>): ValidatedArgs | undefined {
  const quiet = args.quiet === true;
  const model = args.model as string;
  const timeoutSec = resolveTimeoutSec(args.timeout as string | undefined, model);

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    fail(`--timeout must be a positive number, got "${String(args.timeout)}"`); return;
  }

  const format = validateFormat(args.format as string);
  if (format === undefined) {return undefined;}

  const filePaths = validateFileArgs();
  if (filePaths === undefined) {return undefined;}

  const thinkingEffort = args.thinkingEffort as ThinkingEffortLevel | undefined;
  const effortError = validateThinkingEffort(thinkingEffort, model);
  if (effortError !== undefined) {fail(effortError); return;}

  const chatOptions = validateChatOptions(args);
  if (chatOptions === undefined) {return undefined;}

  let stdinData: string;
  try {
    stdinData = readStdin();
  } catch (error: unknown) {
    fail(errorMessage(error)); return;
  }
  const prompt = buildPrompt(args.prompt as string, stdinData);

  return {
    quiet,
    model,
    timeoutMs: timeoutSec * 1000,
    timeoutSec,
    format,
    filePaths,
    thinkingEffort,
    prompt,
    ...chatOptions,
  };
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
    thinkingEffort: {
      type: 'string',
      description: 'Thinking effort level: light, standard, extended, deep',
    },
    continue: {
      type: 'boolean',
      description: 'Continue in the current chat instead of starting a new one',
    },
    chat: {
      type: 'string',
      description: 'Chat ID to continue in (requires --continue)',
    },
    project: {
      type: 'string',
      description: 'Project name to ask within',
    },
  },
  async run({ args }): Promise<void> {
    const validated = validateArgs(args);
    if (validated === undefined) {return;}

    const {
      quiet, model, timeoutMs, timeoutSec, format,
      filePaths, thinkingEffort, prompt,
      continueChat, chatId, project,
    } = validated;

    const browser = new BrowserManager();

    try {
      const page = await browser.getPage(quiet);
      const driver = new ChatGPTDriver(page);

      // Navigation: --continue, --chat, or --project
      if (continueChat && chatId !== undefined) {
        await driver.navigateToChat(chatId, quiet);
      } else if (continueChat) {
        // --continue without --chat: verify the current page is a chat.
        // Note: with CDP, getPage() returns the first ChatGPT tab, which may
        // not be the user's active tab when multiple ChatGPT tabs are open.
        // Use --chat <id> for deterministic behaviour in multi-tab setups.
        const { pathname } = new URL(page.url());
        if (!pathname.startsWith('/c/')) {
          throw new Error(
            'Current page is not a chat. Use --chat <id> to specify which chat to continue.',
          );
        }
      } else if (project !== undefined) {
        await driver.navigateToProject(project, quiet);
      } else {
        await driver.navigateToNewChat(quiet);
      }

      // Skip model selection when continuing an existing chat
      if (!continueChat) {
        await driver.selectModel(model, quiet);
      }

      if (thinkingEffort !== undefined) {
        await driver.setThinkingEffort(thinkingEffort, model, quiet);
      }

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
      fail(errorMessage(error));
    } finally {
      await browser.close();
    }
  },
});
