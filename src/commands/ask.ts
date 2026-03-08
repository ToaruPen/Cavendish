import { fstatSync, readFileSync } from 'node:fs';

import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { BrowserManager } from '../core/browser-manager.js';
import { ChatGPTDriver, type WaitForResponseResult } from '../core/chatgpt-driver.js';
import { FORMAT_ARG, GLOBAL_ARGS, STREAM_ARG, extractArgsOrFail, extractFileArgs, findMissingFile } from '../core/cli-args.js';
import { allowedThinkingEfforts, supportsGitHub, THINKING_EFFORT_LEVELS, type ThinkingEffortLevel } from '../core/model-config.js';
import { emitChunk, emitFinal, errorMessage, failStructured, failValidation, json, progress, text, validateFormat } from '../core/output-handler.js';

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
  if (prompt.length === 0) {
    return stdinData;
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
  stream: boolean;
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
  if (!THINKING_EFFORT_LEVELS.includes(thinkingEffort)) {
    return `--thinking-effort must be one of: ${THINKING_EFFORT_LEVELS.join(', ')}. Got "${thinkingEffort}"`;
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
export function validateFileArgs(format?: 'json' | 'text'): string[] | undefined {
  let filePaths: string[];
  try {
    filePaths = extractFileArgs(process.argv);
  } catch (error: unknown) {
    failValidation(errorMessage(error), format);
    return undefined;
  }

  let missingFile: string | undefined;
  try {
    missingFile = findMissingFile(filePaths);
  } catch (error: unknown) {
    failValidation(errorMessage(error), format);
    return undefined;
  }
  if (missingFile !== undefined) {
    failValidation(`file not found or not a regular file: ${missingFile}`, format);
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
  format: 'json' | 'text',
): { continueChat: boolean; chatId: string | undefined; project: string | undefined } | undefined {
  const chatId = args.chat as string | undefined;
  const project = args.project as string | undefined;
  // --chat implies --continue; explicit --continue flag is optional when --chat is given
  const continueChat = args.continue === true || chatId !== undefined;

  if (chatId !== undefined && chatId === '') {
    failValidation('--chat cannot be empty. Use: --chat <id>', format);
    return undefined;
  }
  if (chatId !== undefined) {
    try {
      assertValidChatId(chatId);
    } catch (error: unknown) {
      failValidation(errorMessage(error), format);
      return undefined;
    }
  }
  if (project !== undefined && project === '') {
    failValidation('--project cannot be empty. Use: --project <name>', format);
    return undefined;
  }
  if (continueChat && project !== undefined) {
    failValidation('--continue/--chat and --project cannot be used together.', format);
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

  // Resolve format first so all subsequent validation errors respect --format json
  const format = validateFormat(args.format as string);
  if (format === undefined) {return undefined;}

  const timeoutSec = resolveTimeoutSec(args.timeout as string | undefined, model);

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    failValidation(`--timeout must be a positive number, got "${String(args.timeout)}"`, format); return;
  }

  const filePaths = validateFileArgs(format);
  if (filePaths === undefined) {return undefined;}

  const gdriveFiles = extractArgsOrFail('gdrive', format);
  if (gdriveFiles === undefined) {return undefined;}

  const githubRepos = extractArgsOrFail('github', format);
  if (githubRepos === undefined) {return undefined;}

  const chatOptions = validateChatOptions(args, format);
  if (chatOptions === undefined) {return undefined;}

  // Skip GitHub model check when continuing — the chat already has its model.
  if (githubRepos.length > 0 && !chatOptions.continueChat && !supportsGitHub(model)) {
    failValidation(`--github requires a model with GitHub support (e.g. Thinking). Model "${model}" does not support GitHub in standard chat.`, format);
    return undefined;
  }

  const agentMode = args.agent === true;

  const thinkingEffort = args.thinkingEffort as ThinkingEffortLevel | undefined;
  if (thinkingEffort !== undefined && chatOptions.continueChat) {
    failValidation('--thinking-effort cannot be used with --continue. The continued chat uses its existing model.', format); return;
  }
  const effortError = validateThinkingEffort(thinkingEffort, model);
  if (effortError !== undefined) {failValidation(effortError, format); return;}

  let stdinData: string;
  try {
    stdinData = readStdin();
  } catch (error: unknown) {
    failValidation(errorMessage(error), format); return;
  }
  const rawPrompt = (args.prompt as string | undefined) ?? '';
  if (rawPrompt.length === 0 && stdinData.length === 0) {
    failValidation('Prompt is required. Provide as argument or pipe via stdin.', format); return;
  }
  const prompt = buildPrompt(rawPrompt, stdinData);
  const stream = args.stream === true;

  return {
    quiet,
    model,
    timeoutMs: timeoutSec * 1000,
    timeoutSec,
    format,
    stream,
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
  if (v.stream) {parts.push('stream: true');}
  if (v.filePaths.length > 0) {parts.push(`${String(v.filePaths.length)} file(s)`);}
  if (v.gdriveFiles.length > 0) {parts.push(`${String(v.gdriveFiles.length)} Google Drive file(s)`);}
  if (v.githubRepos.length > 0) {parts.push(`${String(v.githubRepos.length)} GitHub repo(s)`);}
  return `[dry-run] Would send prompt to ChatGPT (${parts.join(', ')})`;
}

/**
 * Write the ask command result to stdout in the appropriate format.
 */
function writeResult(
  result: WaitForResponseResult,
  opts: {
    format: 'json' | 'text';
    stream: boolean;
    model: string | undefined;
    chatId?: string;
    url?: string;
    project?: string;
    timeoutSec: number;
  },
): void {
  if (opts.stream) {
    emitFinal(result.text, { partial: !result.completed, model: opts.model, chatId: opts.chatId, url: opts.url, project: opts.project, timeoutSec: opts.timeoutSec });
  } else if (opts.format === 'text') {
    text(result.text);
  } else {
    json(result.text, {
      partial: !result.completed,
      model: opts.model,
      chatId: opts.chatId,
      url: opts.url,
      project: opts.project,
      timeoutSec: opts.timeoutSec,
    });
  }
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
    const recent = await driver.getMostRecentChatId(quiet);
    if (recent === undefined) {
      throw new Error(
        'No conversations found in sidebar. Cannot continue — start a new chat first.',
      );
    }
    progress(`Continuing most recent chat: ${recent.chatId}`, quiet);
    await driver.navigateToChat(recent.chatId, quiet, recent.href);
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
    description:
      'Send a prompt to ChatGPT and return the response.\n\n'
      + 'Usage:\n'
      + '  cavendish ask "Explain closures in JS"\n'
      + '  echo "hello" | cavendish ask "Summarize this"\n'
      + '  cat file.ts | cavendish ask "Review this code"\n'
      + '  cavendish ask "Fix the bug" --model Thinking --file src/app.ts\n'
      + '  cavendish ask "Continue" --continue\n'
      + '  cavendish ask "Follow up" --chat <id>',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'The prompt to send to ChatGPT (can also be provided via stdin pipe)',
      required: false,
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
    ...STREAM_ARG,
  },
  async run({ args }): Promise<void> {
    const validated = validateArgs(args);
    if (validated === undefined) {return;}

    if (args.dryRun === true) {
      progress(dryRunMessage(validated), false);
      return;
    }

    const {
      quiet, model, timeoutMs, timeoutSec, format, stream,
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

      const onChunk = stream ? (chunk: string): void => { emitChunk(chunk); } : undefined;

      const result = await driver.waitForResponse({
        timeout: timeoutMs,
        quiet,
        initialMsgCount,
        onChunk,
      });

      const chatId = driver.extractChatId();
      const url = driver.getCurrentUrl();

      writeResult(result, {
        format,
        stream,
        model: continueChat ? undefined : model,
        chatId,
        url,
        project,
        timeoutSec,
      });
    } catch (error: unknown) {
      failStructured(error, format);
    } finally {
      await browser.close();
    }
  },
});
