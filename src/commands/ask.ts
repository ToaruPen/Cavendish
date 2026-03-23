import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { BrowserManager } from '../core/browser-manager.js';
import { ChatGPTDriver, type WaitForResponseResult } from '../core/chatgpt-driver.js';
import { FORMAT_ARG, GLOBAL_ARGS, STREAM_ARG, buildPrompt, extractArgsOrFail, formatTimeoutDisplay, parseUploadTimeout, readStdin, rejectUnknownFlags, toTimeoutMs, validateFileArgs } from '../core/cli-args.js';
import { delay } from '../core/driver/helpers.js';
import { CavendishError } from '../core/errors.js';
import { type DetachedSubmitPayload, validateDetachedOptions, writeDetachedSubmit } from '../core/jobs/helpers.js';
import { getJobFilePath } from '../core/jobs/store.js';
import { submitDetachedJob } from '../core/jobs/submit.js';
import { allowedThinkingEfforts, supportsGitHub, THINKING_EFFORT_LEVELS, type ThinkingEffortLevel } from '../core/model-config.js';
import { emitChunk, emitFinal, errorMessage, failStructured, failValidation, json, progress, text, validateFormat, verbose } from '../core/output-handler.js';
import { acquireLock, releaseLock } from '../core/process-lock.js';
import { registerCleanup } from '../core/shutdown.js';

const DEFAULT_MODEL = 'Pro';
// Continue/chat follow-up baselines poll for at most ~2s (8 x 250ms) so the
// existing assistant turn can settle without adding a long pre-send delay.
const CONTINUED_CHAT_COUNT_SETTLE_MS = 250;
const CONTINUED_CHAT_MAX_POLLS = 8;

const ASK_ARGS = {
  prompt: {
    type: 'positional' as const,
    description: 'The prompt to send to ChatGPT (can also be provided via stdin pipe)',
    required: false,
  },
  timeout: {
    type: 'string' as const,
    description: 'Response timeout in seconds (default: unlimited)',
  },
  model: {
    type: 'string' as const,
    description: 'ChatGPT model to use (default: Pro)',
    default: DEFAULT_MODEL,
  },
  file: {
    type: 'string' as const,
    description: 'File(s) to attach (repeatable: --file a.ts --file b.ts)',
  },
  thinkingEffort: {
    type: 'string' as const,
    description: 'Thinking effort level: light, standard, extended, deep',
  },
  continue: {
    type: 'boolean' as const,
    description: 'Continue the most recent chat (deterministic; use --chat <id> for a specific chat)',
  },
  chat: {
    type: 'string' as const,
    description: 'Chat ID to continue (implies --continue; e.g. --chat abc123)',
  },
  project: {
    type: 'string' as const,
    description: 'Project name to ask within',
  },
  gdrive: {
    type: 'string' as const,
    description: 'Google Drive file(s) to attach (repeatable: --gdrive "file1" --gdrive "file2")',
  },
  github: {
    type: 'string' as const,
    description: 'GitHub repo(s) as context (repeatable: --github "owner/repo")',
  },
  agent: {
    type: 'boolean' as const,
    description: 'Enable agent mode (code execution, file operations)',
  },
  uploadTimeout: {
    type: 'string' as const,
    description: 'Upload timeout in seconds for file attachments (default: 180)',
  },
  detach: {
    type: 'boolean' as const,
    description: 'Submit as a detached background job (default; use --sync to override)',
  },
  sync: {
    type: 'boolean' as const,
    description: 'Run synchronously instead of detached (default: detached)',
  },
  notifyFile: {
    type: 'string' as const,
    description: 'Append a JSON notification line to this file when the detached job finishes',
  },
  ...GLOBAL_ARGS,
  ...FORMAT_ARG,
  ...STREAM_ARG,
};

/**
 * Resolve the effective timeout: use explicit --timeout if provided,
 * otherwise return 0 (unlimited).
 */
function resolveTimeoutSec(
  explicitTimeout: string | undefined,
): number {
  if (explicitTimeout !== undefined) {
    return Number(explicitTimeout);
  }
  return 0; // unlimited
}

interface ValidatedArgs {
  quiet: boolean;
  isVerbose: boolean;
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
  uploadTimeoutMs: number | undefined;
  detach: boolean;
  notifyFile: string | undefined;
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

function resolvePrompt(
  args: Record<string, unknown>,
  format: 'json' | 'text',
): string | undefined {
  let stdinData: string;
  try {
    stdinData = readStdin();
  } catch (error: unknown) {
    failValidation(errorMessage(error), format);
    return undefined;
  }
  const rawPrompt = (args.prompt as string | undefined) ?? '';
  if (rawPrompt.length === 0 && stdinData.length === 0) {
    failValidation('Prompt is required. Provide as argument or pipe via stdin.', format);
    return undefined;
  }
  return buildPrompt(rawPrompt, stdinData);
}

/**
 * Parse and validate all CLI arguments. Returns undefined on validation failure
 * (exitCode is set and error is logged).
 */
function validateArgs(args: Record<string, unknown>): ValidatedArgs | undefined {
  const quiet = args.quiet === true;
  const isVerbose = args.verbose === true;
  const model = args.model as string;

  // Resolve format first so all subsequent validation errors respect --format json
  const format = validateFormat(args.format as string);
  if (format === undefined) {return undefined;}

  if (!rejectUnknownFlags(ASK_ARGS, format)) {return undefined;}

  const timeoutSec = resolveTimeoutSec(args.timeout as string | undefined);

  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
    failValidation(`--timeout must be a non-negative number, got "${String(args.timeout)}"`, format); return;
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

  const uploadTimeoutMs = parseUploadTimeout(args.uploadTimeout as string | undefined, format);
  if (uploadTimeoutMs === null) { return undefined; }

  const thinkingEffort = args.thinkingEffort as ThinkingEffortLevel | undefined;
  if (thinkingEffort !== undefined && chatOptions.continueChat) {
    failValidation('--thinking-effort cannot be used with --continue. The continued chat uses its existing model.', format); return;
  }
  const effortError = validateThinkingEffort(thinkingEffort, model);
  if (effortError !== undefined) {failValidation(effortError, format); return;}

  const prompt = resolvePrompt(args, format);
  if (prompt === undefined) { return undefined; }
  const stream = args.stream === true;
  const detachedOptions = validateDetachedOptions(args, format, stream);
  if (detachedOptions === undefined) { return undefined; }

  return {
    quiet,
    isVerbose,
    model,
    timeoutMs: toTimeoutMs(timeoutSec),
    timeoutSec,
    format,
    stream,
    filePaths,
    gdriveFiles,
    githubRepos,
    agentMode,
    thinkingEffort,
    prompt,
    uploadTimeoutMs,
    ...chatOptions,
    ...detachedOptions,
  };
}

/**
 * Build the dry-run summary message for the ask command.
 */
function dryRunMessage(v: ValidatedArgs): string {
  const parts = [`model: ${v.model}`, `format: ${v.format}`, `timeout: ${formatTimeoutDisplay(v.timeoutSec)}`];
  if (v.chatId !== undefined) {parts.push(`chat: ${v.chatId}`);}
  else if (v.continueChat) {parts.push('continue: most recent');}
  if (v.stream) {parts.push('stream: true');}
  if (v.detach) {parts.push('detach: true');}
  if (v.notifyFile !== undefined) {parts.push(`notifyFile: ${v.notifyFile}`);}
  if (v.uploadTimeoutMs !== undefined) {parts.push(`uploadTimeout: ${String(v.uploadTimeoutMs / 1000)}s`);}
  if (v.filePaths.length > 0) {parts.push(`${String(v.filePaths.length)} file(s)`);}
  if (v.gdriveFiles.length > 0) {parts.push(`${String(v.gdriveFiles.length)} Google Drive file(s)`);}
  if (v.githubRepos.length > 0) {parts.push(`${String(v.githubRepos.length)} GitHub repo(s)`);}
  return `[dry-run] Would send prompt to ChatGPT (${parts.join(', ')})`;
}

function buildAskJobArgv(validated: ValidatedArgs): string[] {
  const argv = ['ask', '--model', validated.model, '--timeout', String(validated.timeoutSec)];
  if (validated.continueChat) {
    argv.push('--continue');
  }
  if (validated.chatId !== undefined) {
    argv.push('--chat', validated.chatId);
  }
  if (validated.project !== undefined) {
    argv.push('--project', validated.project);
  }
  for (const filePath of validated.filePaths) {
    argv.push('--file', filePath);
  }
  for (const gdriveFile of validated.gdriveFiles) {
    argv.push('--gdrive', gdriveFile);
  }
  for (const githubRepo of validated.githubRepos) {
    argv.push('--github', githubRepo);
  }
  if (validated.agentMode) {
    argv.push('--agent');
  }
  if (validated.thinkingEffort !== undefined) {
    argv.push('--thinking-effort', validated.thinkingEffort);
  }
  if (validated.uploadTimeoutMs !== undefined) {
    argv.push('--upload-timeout', String(validated.uploadTimeoutMs / 1000));
  }
  return argv;
}

async function captureInitialFollowUpBaseline(
  driver: ChatGPTDriver,
  continueChat: boolean,
): Promise<{ initialMsgCount: number; initialResponseText: string | undefined }> {
  let lastCount = await driver.getAssistantMessageCount();
  if (!continueChat) {
    return {
      initialMsgCount: lastCount,
      initialResponseText: undefined,
    };
  }

  let lastText = await driver.getLastResponse();
  for (let poll = 0; poll < CONTINUED_CHAT_MAX_POLLS; poll += 1) {
    await delay(CONTINUED_CHAT_COUNT_SETTLE_MS);
    const nextCount = await driver.getAssistantMessageCount();
    const nextText = await driver.getLastResponse();
    if (nextCount === lastCount && nextText.length > 0 && nextText === lastText) {
      return {
        initialMsgCount: nextCount,
        initialResponseText: nextText,
      };
    }
    lastCount = nextCount;
    lastText = nextText;
  }

  return {
    initialMsgCount: lastCount,
    initialResponseText: lastText.length > 0 ? lastText : undefined,
  };
}

function submitDetachedAskJob(validated: ValidatedArgs): DetachedSubmitPayload {
  const record = submitDetachedJob({
    kind: 'ask',
    argv: buildAskJobArgv(validated),
    prompt: validated.prompt,
    notifyFile: validated.notifyFile,
  });
  return {
    jobId: record.jobId,
    status: record.status,
    kind: record.kind,
    submittedAt: record.submittedAt,
    jobPath: getJobFilePath(record.jobId),
    eventsPath: record.eventsPath,
    chatId: validated.chatId,
    notifyFile: validated.notifyFile,
  };
}

function handleDryRunOrDetach(
  args: Record<string, unknown>,
  validated: ValidatedArgs,
): boolean {
  if (args.dryRun === true) {
    progress(dryRunMessage(validated), false);
    return true;
  }
  if (!validated.detach) {
    return false;
  }
  const payload = submitDetachedAskJob(validated);
  writeDetachedSubmit(payload, validated.format);
  return true;
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

async function applyComposerOptions(
  driver: ChatGPTDriver,
  validated: ValidatedArgs,
): Promise<void> {
  const {
    quiet,
    model,
    continueChat,
    thinkingEffort,
    filePaths,
    gdriveFiles,
    githubRepos,
    agentMode,
    uploadTimeoutMs,
  } = validated;

  if (!continueChat) {
    await driver.selectModel(model, quiet);
  }

  if (thinkingEffort !== undefined) {
    await driver.setThinkingEffort(thinkingEffort, model, quiet);
  }

  if (filePaths.length > 0) {
    await driver.attachFiles(filePaths, quiet, undefined, uploadTimeoutMs);
  }

  for (const gdFile of gdriveFiles) {
    await driver.attachGoogleDriveFile(gdFile, quiet, undefined, uploadTimeoutMs);
  }

  for (const repo of githubRepos) {
    await driver.attachGitHubRepo(repo, quiet);
  }

  if (agentMode) {
    await driver.enableAgentMode(quiet);
  }
}

function assertCompletedResponse(
  result: WaitForResponseResult,
  timeoutSec: number,
): void {
  if (timeoutSec === 0 || result.completed || process.env.CAVENDISH_ALLOW_PARTIAL === '1') {
    return;
  }

  throw new CavendishError(
    `Timed out waiting for a final response after ${String(timeoutSec)}s.`,
    'timeout',
    'Retry with a larger --timeout if ChatGPT is still generating, or inspect the browser tab for a stalled response.',
  );
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
  args: ASK_ARGS,
  async run({ args }): Promise<void> {
    const validated = validateArgs(args);
    if (validated === undefined) {return;}

    if (handleDryRunOrDetach(args, validated)) {
      return;
    }

    const {
      quiet, isVerbose, model, timeoutMs, timeoutSec, format, stream, prompt, project,
    } = validated;
    verbose(`Model: ${model}, timeout: ${String(timeoutSec)}s, format: ${format}`, isVerbose);
    if (validated.chatId !== undefined) {
      verbose(`Target chat: ${validated.chatId}`, isVerbose);
    }

    const browser = new BrowserManager();

    // Register cleanup before getPage() so SIGINT/SIGTERM during page
    // acquisition can still close the tab. closePage() is idempotent.
    const unregisterPageCleanup = registerCleanup(async (): Promise<void> => {
      await browser.closePage();
    });

    try {
      verbose('Acquiring process lock...', isVerbose);
      acquireLock();
      verbose('Process lock acquired', isVerbose);
      const page = await browser.getPage(quiet, [], isVerbose);
      const driver = new ChatGPTDriver(page);

      verbose('Navigating...', isVerbose);
      await navigate(driver, validated);

      verbose(`Selecting model: ${model}`, isVerbose);
      await applyComposerOptions(driver, validated);

      progress('Sending message...', quiet);
      verbose(`Sending message (prompt length: ${String(prompt.length)} chars)...`, isVerbose);
      const { initialMsgCount, initialResponseText } = await captureInitialFollowUpBaseline(driver, validated.continueChat);
      await driver.sendMessage(prompt);

      verbose(`Waiting for response (timeout: ${String(timeoutSec)}s, initialMsgCount: ${String(initialMsgCount)})...`, isVerbose);
      const onChunk = stream ? (chunk: string): void => { emitChunk(chunk); } : undefined;

      const result = await driver.waitForResponse({
        timeout: timeoutMs,
        quiet,
        initialMsgCount,
        initialResponseText,
        onChunk,
      });
      assertCompletedResponse(result, timeoutSec);

      const chatId = driver.extractChatId();
      const url = driver.getCurrentUrl();

      writeResult(result, {
        format,
        stream,
        model: validated.continueChat ? undefined : model,
        chatId,
        url,
        project,
        timeoutSec,
      });
    } catch (error: unknown) {
      failStructured(error, format);
    } finally {
      try {
        try {
          await browser.closePage();
        } finally {
          // Unregister AFTER closePage completes — if a signal arrived during
          // closePage, the cleanup callback's redundant close is harmless
          // (closePage is idempotent). Unregistering before closePage would
          // leave a window where the tab leaks on signal.
          unregisterPageCleanup();
          await browser.close();
        }
      } finally {
        verbose('Releasing process lock...', isVerbose);
        releaseLock();
      }
    }
  },
});
