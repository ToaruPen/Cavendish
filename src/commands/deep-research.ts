import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import { assertValidChatId, SELECTORS } from '../constants/selectors.js';
import type { ChatGPTDriver, DeepResearchExportFormat } from '../core/chatgpt-driver.js';
import { FORMAT_ARG, GLOBAL_ARGS, STREAM_ARG, buildPrompt, formatTimeoutDisplay, parseUploadTimeout, readStdin, rejectUnknownFlags, toTimeoutMs, validateFileArgs } from '../core/cli-args.js';
import { type DetachedSubmitPayload, validateDetachedOptions, writeDetachedSubmit } from '../core/jobs/helpers.js';
import { getJobFilePath } from '../core/jobs/store.js';
import { submitDetachedJob } from '../core/jobs/submit.js';
import { emitFinal, emitState, errorMessage, failValidation, json, progress, text, validateFormat, verbose } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

const DEFAULT_TIMEOUT_SEC = 0; // unlimited

const DEEP_RESEARCH_ARGS = {
  prompt: {
    type: 'positional' as const,
    description: 'The prompt to send to Deep Research',
    required: false,
  },
  chat: {
    type: 'string' as const,
    description: 'Chat ID of an existing DR session to send a follow-up',
  },
  refresh: {
    type: 'boolean' as const,
    description: 'Re-run the same prompt on an existing DR session (requires --chat)',
  },
  timeout: {
    type: 'string' as const,
    description: 'Response timeout in seconds (default: unlimited)',
  },
  file: {
    type: 'string' as const,
    description: 'File(s) to attach (repeatable: --file a.ts --file b.ts)',
  },
  uploadTimeout: {
    type: 'string' as const,
    description: 'Upload timeout in seconds for file attachments (default: 180)',
  },
  export: {
    type: 'string' as const,
    description: 'Export report to file: markdown, word, or pdf (e.g. --export markdown)',
  },
  exportPath: {
    type: 'string' as const,
    description: 'Path to save exported file (default: ./deep-research-report.{ext})',
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

const VALID_EXPORT_FORMATS: readonly DeepResearchExportFormat[] = ['markdown', 'word', 'pdf'];

const EXPORT_EXTENSIONS: Record<DeepResearchExportFormat, string> = {
  markdown: '.md',
  word: '.docx',
  pdf: '.pdf',
};

function defaultExportFilename(format: DeepResearchExportFormat): string {
  return `deep-research-report${EXPORT_EXTENSIONS[format]}`;
}

type RunMode =
  | { kind: 'initial'; prompt: string; filePaths: string[]; uploadTimeoutMs: number | undefined }
  | { kind: 'followup'; chatId: string; prompt: string }
  | { kind: 'refresh'; chatId: string };

interface ValidatedArgs {
  quiet: boolean;
  isVerbose: boolean;
  mode: RunMode;
  format: 'json' | 'text';
  stream: boolean;
  timeoutMs: number;
  timeoutSec: number;
  uploadTimeoutMs: number | undefined;
  exportFormat: DeepResearchExportFormat | undefined;
  exportPath: string | undefined;
  detach: boolean;
  notifyFile: string | undefined;
}

function validateTimeout(raw: unknown, format: 'json' | 'text'): number | undefined {
  if (typeof raw === 'string' && raw.trim().length === 0) {
    failValidation('--timeout cannot be empty. Use: --timeout <seconds>', format);
    return undefined;
  }
  const sec = raw !== undefined ? Number(raw) : DEFAULT_TIMEOUT_SEC;
  if (!Number.isFinite(sec) || sec < 0) {
    failValidation(`--timeout must be a non-negative number, got "${String(raw)}"`, format);
    return undefined;
  }
  return sec;
}

function validateExport(
  rawExport: unknown,
  rawExportPath: unknown,
  format: 'json' | 'text',
): { exportFormat: DeepResearchExportFormat | undefined; exportPath: string | undefined } | undefined {
  const exportFormat = rawExport as DeepResearchExportFormat | undefined;
  if (exportFormat !== undefined && !VALID_EXPORT_FORMATS.includes(exportFormat)) {
    failValidation(`--export must be one of: ${VALID_EXPORT_FORMATS.join(', ')}. Got "${exportFormat}"`, format);
    return undefined;
  }
  if (exportFormat === undefined && rawExportPath !== undefined) {
    failValidation('--exportPath requires --export (e.g. --export markdown --exportPath report.md)', format);
    return undefined;
  }
  return { exportFormat, exportPath: rawExportPath as string | undefined };
}

function validateFlagConflicts(args: Record<string, unknown>, format: 'json' | 'text'): boolean {
  const isFollowUp = args.chat !== undefined;
  const isRefresh = args.refresh === true;

  if (isRefresh && !isFollowUp) {
    failValidation('--refresh requires --chat (specify the DR session to refresh)', format);
    return false;
  }
  if (isFollowUp && args.file !== undefined) {
    failValidation('--file is not supported with --chat', format);
    return false;
  }
  if (isRefresh && args.prompt !== undefined && args.prompt !== '') {
    failValidation('--refresh re-runs the existing prompt; do not provide a new prompt', format);
    return false;
  }
  return true;
}

function resolveRunMode(
  args: Record<string, unknown>,
  stdinData: string,
  filePaths: string[],
  format: 'json' | 'text',
  uploadTimeoutMs: number | undefined,
): RunMode | undefined {
  const isFollowUp = args.chat !== undefined;
  const isRefresh = args.refresh === true;
  const chatId = args.chat as string;

  if (isRefresh) {
    if (stdinData.length > 0) {
      failValidation('--refresh does not accept stdin input', format);
      return undefined;
    }
    return { kind: 'refresh', chatId };
  }

  // Prompt can come from positional arg, stdin, or both (buildPrompt merges them).
  // Require at least one source.
  const prompt = buildPrompt(args.prompt as string | undefined ?? '', stdinData);
  if (prompt.length === 0) {
    failValidation('A prompt is required (positional argument or stdin)', format);
    return undefined;
  }

  if (isFollowUp) {
    return { kind: 'followup', chatId, prompt };
  }

  return { kind: 'initial', prompt, filePaths, uploadTimeoutMs };
}

function validateArgs(args: Record<string, unknown>): ValidatedArgs | undefined {
  const quiet = args.quiet === true;
  const isVerbose = args.verbose === true;

  // Resolve format first so all subsequent validation errors respect --format json
  const format = validateFormat(args.format as string);
  if (format === undefined) { return undefined; }

  if (!rejectUnknownFlags(DEEP_RESEARCH_ARGS, format)) { return undefined; }

  // Validate flags, timeout, export, and file args BEFORE reading
  // stdin so obviously invalid invocations fail fast without blocking on EOF.
  if (!validateFlagConflicts(args, format)) { return undefined; }

  const timeoutSec = validateTimeout(args.timeout, format);
  if (timeoutSec === undefined) { return undefined; }

  const exp = validateExport(args.export, args.exportPath, format);
  if (exp === undefined) { return undefined; }

  // Validate chatId format early to fail fast on invalid characters
  if (args.chat !== undefined) {
    try {
      assertValidChatId(args.chat as string);
    } catch (error: unknown) {
      failValidation(errorMessage(error), format);
      return undefined;
    }
  }

  // Validate file args before stdin (--file missing.txt should fail fast)
  let filePaths: string[] = [];
  if (args.chat === undefined) {
    const validated = validateFileArgs(format);
    if (validated === undefined) { return undefined; }
    filePaths = validated;
  }

  const uploadTimeoutMs = parseUploadTimeout(args.uploadTimeout as string | undefined, format);
  if (uploadTimeoutMs === null) { return undefined; }

  let stdinData: string;
  try {
    stdinData = readStdin();
  } catch (error: unknown) {
    failValidation(errorMessage(error), format);
    return undefined;
  }

  const mode = resolveRunMode(args, stdinData, filePaths, format, uploadTimeoutMs);
  if (mode === undefined) { return undefined; }

  const stream = args.stream === true;
  const detachedOptions = validateDetachedOptions(args, format, stream);
  if (detachedOptions === undefined) { return undefined; }

  return {
    quiet,
    isVerbose,
    mode,
    format,
    stream,
    timeoutMs: toTimeoutMs(timeoutSec),
    timeoutSec,
    uploadTimeoutMs,
    exportFormat: exp.exportFormat,
    exportPath: exp.exportPath,
    ...detachedOptions,
  };
}

function buildDeepResearchJobArgv(v: ValidatedArgs): string[] {
  const argv = ['deep-research'];
  if (v.mode.kind === 'refresh') {
    argv.push('--chat', v.mode.chatId, '--refresh');
  } else if (v.mode.kind === 'followup') {
    argv.push('--chat', v.mode.chatId);
  } else {
    for (const filePath of v.mode.filePaths) {
      argv.push('--file', filePath);
    }
  }
  argv.push('--timeout', String(v.timeoutSec));
  if (v.uploadTimeoutMs !== undefined) {
    argv.push('--upload-timeout', String(v.uploadTimeoutMs / 1000));
  }
  if (v.exportFormat !== undefined) {
    argv.push('--export', v.exportFormat);
  }
  if (v.exportPath !== undefined) {
    argv.push('--exportPath', v.exportPath);
  }
  return argv;
}

function submitDetachedDeepResearchJob(v: ValidatedArgs): DetachedSubmitPayload {
  const record = submitDetachedJob({
    kind: 'deep-research',
    argv: buildDeepResearchJobArgv(v),
    prompt: v.mode.kind !== 'refresh' ? v.mode.prompt : undefined,
    notifyFile: v.notifyFile,
  });
  return {
    jobId: record.jobId,
    status: record.status,
    kind: record.kind,
    submittedAt: record.submittedAt,
    jobPath: getJobFilePath(record.jobId),
    eventsPath: record.eventsPath,
    chatId: v.mode.kind === 'initial' ? undefined : v.mode.chatId,
    notifyFile: v.notifyFile,
  };
}

function dryRunMessage(v: ValidatedArgs): string {
  const parts = [`mode: ${v.mode.kind}`, `format: ${v.format}`, `timeout: ${formatTimeoutDisplay(v.timeoutSec)}`];
  if (v.stream) { parts.push('stream: true'); }
  if (v.uploadTimeoutMs !== undefined) { parts.push(`uploadTimeout: ${String(v.uploadTimeoutMs / 1000)}s`); }
  if (v.mode.kind === 'initial' && v.mode.filePaths.length > 0) {
    parts.push(`${String(v.mode.filePaths.length)} file(s)`);
  }
  if (v.exportFormat !== undefined) { parts.push(`export: ${v.exportFormat}`); }
  if (v.detach) { parts.push('detach: true'); }
  if (v.notifyFile !== undefined) { parts.push(`notifyFile: ${v.notifyFile}`); }
  return `[dry-run] Would send Deep Research query (${parts.join(', ')})`;
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
  const payload = submitDetachedDeepResearchJob(validated);
  writeDetachedSubmit(payload, validated.format);
  return true;
}

/**
 * Send the DR query/action and return a pre-action text snapshot.
 * For follow-up/refresh, the snapshot is taken after navigation but before
 * the action (send/click) so stale-content detection works correctly.
 */
async function sendQuery(driver: ChatGPTDriver, mode: RunMode, quiet: boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  switch (mode.kind) {
    case 'refresh': {
      progress('Refreshing Deep Research session...', quiet);
      return driver.refreshDeepResearch(mode.chatId, quiet, deadline);
    }
    case 'followup': {
      progress('Sending Deep Research follow-up...', quiet);
      return driver.sendDeepResearchFollowUp(mode.chatId, mode.prompt, quiet, deadline);
    }
    case 'initial':
      await driver.navigateToDeepResearch(quiet);
      if (mode.filePaths.length > 0) {
        await driver.attachFiles(mode.filePaths, quiet, SELECTORS.SEND_BUTTON, mode.uploadTimeoutMs);
      }
      progress('Sending Deep Research query...', quiet);
      await driver.sendDeepResearchMessage(mode.prompt);
      return '';
  }
}

/**
 * Write the deep-research result to stdout in the appropriate format.
 */
function writeDRResult(
  reportText: string,
  opts: {
    format: 'json' | 'text';
    stream: boolean;
    chatId: string | undefined;
    url?: string;
    partial: boolean;
    timeoutSec: number;
  },
): void {
  if (opts.stream) {
    emitFinal(reportText, { model: 'deep-research', chatId: opts.chatId, url: opts.url, partial: opts.partial, timeoutSec: opts.timeoutSec });
  } else if (opts.format === 'text') {
    text(reportText);
  } else {
    json(reportText, {
      model: 'deep-research',
      chatId: opts.chatId,
      url: opts.url,
      partial: opts.partial,
      timeoutSec: opts.timeoutSec,
    });
  }
}

/**
 * Attempt to copy clean Markdown via the clipboard when --export is specified.
 * Falls back to the raw text if the clipboard operation fails or is skipped.
 */
async function tryClipboardCopy(
  driver: ChatGPTDriver,
  rawText: string,
  exportFormat: DeepResearchExportFormat | undefined,
  completed: boolean,
  quiet: boolean,
): Promise<string> {
  if (exportFormat === undefined || !completed) {
    return rawText;
  }
  try {
    const markdown = await driver.copyDeepResearchContent();
    if (markdown.length > 0) {
      return markdown;
    }
  } catch (error: unknown) {
    progress(`Copy content failed, using raw text: ${errorMessage(error)}`, quiet);
  }
  return rawText;
}

function resolveChatId(driver: ChatGPTDriver, mode: RunMode, quiet: boolean): string | undefined {
  if (mode.kind === 'followup' || mode.kind === 'refresh') {
    return mode.chatId;
  }
  // Initial mode: extract from URL after DR redirects to /c/{id}
  const chatId = driver.extractChatId();
  if (chatId === undefined) {
    const currentUrl = driver.getCurrentUrl();
    progress(
      `Warning: could not extract chat ID from URL (expected /c/{id} pattern, got: ${currentUrl}). `
      + 'Follow-up commands (--chat) will not work for this session.',
      quiet,
    );
  }
  return chatId;
}

/**
 * `cavendish deep-research` — send a prompt to ChatGPT Deep Research and return the report.
 */
export const deepResearchCommand = defineCommand({
  meta: {
    name: 'deep-research',
    description:
      'Send a prompt to ChatGPT Deep Research and return the report.\n\n'
      + 'Usage:\n'
      + '  cavendish deep-research "Compare React vs Vue in 2026"\n'
      + '  echo "topic" | cavendish deep-research "Analyze this"\n'
      + '  cavendish deep-research "Follow up" --chat <id>\n'
      + '  cavendish deep-research --chat <id> --refresh\n'
      + '  cavendish deep-research "Query" --export markdown --exportPath report.md',
  },
  args: DEEP_RESEARCH_ARGS,
  async run({ args }): Promise<void> {
    const v = validateArgs(args);
    if (v === undefined) { return; }

    const {
      quiet, isVerbose, mode, format, stream, timeoutMs, timeoutSec, exportFormat, exportPath,
    } = v;

    if (handleDryRunOrDetach(args, v)) {
      return;
    }

    verbose(`Mode: ${mode.kind}, timeout: ${String(timeoutSec)}s, format: ${format}`, isVerbose);
    if (exportFormat !== undefined) {
      const exportTarget = exportPath !== undefined ? ` → ${exportPath}` : '';
      verbose(`Export: ${exportFormat}${exportTarget}`, isVerbose);
    }

    // Clipboard permissions are only needed when --export is specified,
    // because copyDeepResearchContent() uses the clipboard to get clean Markdown.
    const permissions = exportFormat !== undefined ? ['clipboard-read', 'clipboard-write'] : [];

    await withDriver(quiet, async (driver) => {
      if (stream) { emitState('sending'); }
      verbose('Sending Deep Research query...', isVerbose);
      const preActionText = await sendQuery(driver, mode, quiet, timeoutMs);

      if (stream) { emitState('researching'); }
      verbose('Waiting for Deep Research response...', isVerbose);
      const isFollowUpOrRefresh = mode.kind === 'refresh' || mode.kind === 'followup';
      const result = await driver.waitForDeepResearchResponse({
        timeout: timeoutMs,
        quiet,
        skipStartPhase: isFollowUpOrRefresh,
        preActionText: isFollowUpOrRefresh ? preActionText : undefined,
      });

      const chatId = resolveChatId(driver, mode, quiet);
      if (chatId !== undefined) {
        progress(`Chat ID: ${chatId}`, quiet);
      }

      if (stream) { emitState('generating'); }
      verbose(`Research completed: ${result.completed ? 'full' : 'partial'}`, isVerbose);

      // Get clean Markdown text via clipboard copy when --export is specified
      // (requires clipboard permissions granted above). Without --export, use raw text.
      const reportText = await tryClipboardCopy(driver, result.text, exportFormat, result.completed, quiet);

      // Export to file if requested (after copy, so export menu state is clean).
      // On incomplete reports, skip export but still output the partial result.
      if (exportFormat !== undefined) {
        if (!result.completed) {
          const target = exportPath ?? defaultExportFilename(exportFormat);
          progress(`Export skipped: report is incomplete; "${target}" not written`, quiet);
        } else {
          const savePath = resolve(exportPath ?? defaultExportFilename(exportFormat));
          await driver.exportDeepResearch(exportFormat, savePath, quiet);
        }
      }

      const url = driver.getCurrentUrl();

      writeDRResult(reportText, {
        format,
        stream,
        chatId,
        url,
        partial: !result.completed,
        timeoutSec,
      });
    }, format, { permissions, verbose: isVerbose });
  },
});
