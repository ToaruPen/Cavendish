import { fstatSync, readFileSync } from 'node:fs';

import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { BrowserManager } from '../core/browser-manager.js';
import { ChatGPTDriver, type ThinkingEffortLevel } from '../core/chatgpt-driver.js';
import { FORMAT_ARG, GLOBAL_ARGS, extractArgsOrFail, extractFileArgs, findMissingFile } from '../core/cli-args.js';
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

/**
 * Check whether a model supports GitHub integration in standard chat.
 * Only Thinking (Agent Mode) supports GitHub; Deep Research has its own path.
 */
function supportsGitHub(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('thinking');
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
  gdriveFiles: string[];
  githubRepos: string[];
  agentMode: boolean;
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
export function validateFileArgs(): string[] | undefined {
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

/** Validate --continue / --chat / --project mutual-exclusion rules.
 *
 * Priority:
 *  1. `--chat <id>` (with or without --continue) → navigate to that chat (implicit continue)
 *  2. `--continue` alone → navigate to the most recent chat (deterministic)
 *  3. Neither → new chat
 */
function validateChatOptions(
  args: Record<string, unknown>,
): { continueChat: boolean; chatId: string | undefined; project: string | undefined } | undefined {
  const chatId = args.chat as string | undefined;
  const project = args.project as string | undefined;
  // --chat implies --continue; explicit --continue flag is optional when --chat is given
  const continueChat = args.continue === true || chatId !== undefined;

  if (chatId !== undefined && chatId === '') {
    fail('--chat cannot be empty. Use: --chat <id>');
    return undefined;
  }
  if (chatId !== undefined) {
    try {
      assertValidChatId(chatId);
    } catch (error: unknown) {
      fail(errorMessage(error));
      return undefined;
    }
  }
  if (project !== undefined && project === '') {
    fail('--project cannot be empty. Use: --project <name>');
    return undefined;
  }
  if (continueChat && project !== undefined) {
    fail('--continue/--chat and --project cannot be used together.');
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

  const gdriveFiles = extractArgsOrFail('gdrive');
  if (gdriveFiles === undefined) {return undefined;}

  const githubRepos = extractArgsOrFail('github');
  if (githubRepos === undefined) {return undefined;}

  const chatOptions = validateChatOptions(args);
  if (chatOptions === undefined) {return undefined;}

  // Skip GitHub model check when continuing — the chat already has its model.
  if (githubRepos.length > 0 && !chatOptions.continueChat && !supportsGitHub(model)) {
    fail(`--github requires a model with GitHub support (e.g. Thinking). Model "${model}" does not support GitHub in standard chat.`);
    return undefined;
  }

  const agentMode = args.agent === true;

  const thinkingEffort = args.thinkingEffort as ThinkingEffortLevel | undefined;
  if (thinkingEffort !== undefined && chatOptions.continueChat) {
    fail('--thinking-effort cannot be used with --continue. The continued chat uses its existing model.'); return;
  }
  const effortError = validateThinkingEffort(thinkingEffort, model);
  if (effortError !== undefined) {fail(effortError); return;}

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
    gdriveFiles,
    githubRepos,
    agentMode,
    thinkingEffort,
    prompt,
    ...chatOptions,
  };
}

/**
 * Build the dry-run summary message for the ask command.
 */
function dryRunMessage(v: ValidatedArgs): string {
  const parts = [`model: ${v.model}`, `format: ${v.format}`, `timeout: ${String(v.timeoutSec)}s`];
  if (v.chatId !== undefined) {parts.push(`chat: ${v.chatId}`);}
  else if (v.continueChat) {parts.push('continue: most recent');}
  if (v.filePaths.length > 0) {parts.push(`${String(v.filePaths.length)} file(s)`);}
  if (v.gdriveFiles.length > 0) {parts.push(`${String(v.gdriveFiles.length)} Google Drive file(s)`);}
  if (v.githubRepos.length > 0) {parts.push(`${String(v.githubRepos.length)} GitHub repo(s)`);}
  return `[dry-run] Would send prompt to ChatGPT (${parts.join(', ')})`;
}

/**
 * Handle navigation based on --continue, --chat, and --project flags.
 *
 * Priority:
 *  1. `--chat <id>` → navigate to that specific chat
 *  2. `--continue` (no --chat) → navigate to the most recent chat from sidebar
 *  3. `--project <name>` → navigate to project
 *  4. None → new chat
 */
async function navigate(
  driver: ChatGPTDriver,
  validated: ValidatedArgs,
): Promise<void> {
  const { continueChat, chatId, project, quiet } = validated;

  if (chatId !== undefined) {
    await driver.navigateToChat(chatId, quiet);
  } else if (continueChat) {
    const recentId = await driver.getMostRecentChatId(quiet);
    if (recentId === undefined) {
      throw new Error(
        'No conversations found in sidebar. Cannot continue — start a new chat first.',
      );
    }
    progress(`Continuing most recent chat: ${recentId}`, quiet);
    await driver.navigateToChat(recentId, quiet);
  } else if (project !== undefined) {
    await driver.navigateToProject(project, quiet);
  } else {
    await driver.navigateToNewChat(quiet);
  }
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
      description: 'Continue the most recent chat (deterministic; use --chat <id> for a specific chat)',
    },
    chat: {
      type: 'string',
      description: 'Chat ID to continue (implies --continue; e.g. --chat abc123)',
    },
    project: {
      type: 'string',
      description: 'Project name to ask within',
    },
    gdrive: {
      type: 'string',
      description: 'Google Drive file(s) to attach (repeatable: --gdrive "file1" --gdrive "file2")',
    },
    github: {
      type: 'string',
      description: 'GitHub repo(s) as context (repeatable: --github "owner/repo")',
    },
    agent: {
      type: 'boolean',
      description: 'Enable agent mode (code execution, file operations)',
    },
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
  },
  async run({ args }): Promise<void> {
    const validated = validateArgs(args);
    if (validated === undefined) {return;}

    if (args.dryRun === true) {
      progress(dryRunMessage(validated), false);
      return;
    }

    const {
      quiet, model, timeoutMs, timeoutSec, format,
      filePaths, gdriveFiles, githubRepos, agentMode, thinkingEffort, prompt, continueChat,
      project,
    } = validated;

    const browser = new BrowserManager();

    try {
      const page = await browser.getPage(quiet);
      const driver = new ChatGPTDriver(page);

      await navigate(driver, validated);

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

      for (const gdFile of gdriveFiles) {
        await driver.attachGoogleDriveFile(gdFile, quiet);
      }

      for (const repo of githubRepos) {
        await driver.attachGitHubRepo(repo, quiet);
      }

      if (agentMode) {
        await driver.enableAgentMode(quiet);
      }

      progress('Sending message...', quiet);
      const initialMsgCount = await driver.getAssistantMessageCount();
      await driver.sendMessage(prompt);

      const result = await driver.waitForResponse({
        timeout: timeoutMs,
        quiet,
        initialMsgCount,
      });

      const chatId = driver.extractChatId();
      const url = driver.getCurrentUrl();

      if (format === 'text') {
        text(result.text);
      } else {
        json(result.text, {
          partial: !result.completed,
          model: continueChat ? undefined : model,
          chatId,
          url,
          project,
          timeoutSec,
        });
      }
    } catch (error: unknown) {
      fail(errorMessage(error));
    } finally {
      await browser.close();
    }
  },
});
