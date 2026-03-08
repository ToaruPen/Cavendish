import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import type { ChatGPTDriver, DeepResearchExportFormat } from '../core/chatgpt-driver.js';
import { FORMAT_ARG, GLOBAL_ARGS, STREAM_ARG } from '../core/cli-args.js';
import { emitFinal, emitState, errorMessage, failValidation, json, progress, text, validateFormat } from '../core/output-handler.js';
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

type RunMode =
  | { kind: 'initial'; prompt: string; filePaths: string[] }
  | { kind: 'followup'; chatId: string; prompt: string }
  | { kind: 'refresh'; chatId: string };

interface ValidatedArgs {
  quiet: boolean;
  mode: RunMode;
  format: 'json' | 'text';
  stream: boolean;
  timeoutMs: number;
  timeoutSec: number;
  exportFormat: DeepResearchExportFormat | undefined;
  exportPath: string | undefined;
}

function validateTimeout(raw: unknown, format: 'json' | 'text'): number | undefined {
  const sec = raw !== undefined ? Number(raw) : DEFAULT_TIMEOUT_SEC;
  if (!Number.isFinite(sec) || sec <= 0) {
    failValidation(`--timeout must be a positive number, got "${String(raw)}"`, format);
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

  return { kind: 'initial', prompt, filePaths };
}

function validateArgs(args: Record<string, unknown>): ValidatedArgs | undefined {
  const quiet = args.quiet === true;

  // Resolve format first so all subsequent validation errors respect --format json
  const format = validateFormat(args.format as string);
  if (format === undefined) { return undefined; }

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

  let stdinData: string;
  try {
    stdinData = readStdin();
  } catch (error: unknown) {
    failValidation(errorMessage(error), format);
    return undefined;
  }

  const mode = resolveRunMode(args, stdinData, filePaths, format);
  if (mode === undefined) { return undefined; }

  const stream = args.stream === true;

  return {
    quiet,
    mode,
    format,
    stream,
    timeoutMs: timeoutSec * 1000,
    timeoutSec,
    exportFormat: exp.exportFormat,
    exportPath: exp.exportPath,
  };
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
        await driver.attachFiles(mode.filePaths, quiet);
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
      + '  cavendish deep-research "Compare React vs Vue in 2025"\n'
      + '  echo "topic" | cavendish deep-research "Analyze this"\n'
      + '  cavendish deep-research "Follow up" --chat <id>\n'
      + '  cavendish deep-research --chat <id> --refresh\n'
      + '  cavendish deep-research "Query" --export markdown --exportPath report.md',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'The prompt to send to Deep Research',
      required: false,
    },
    chat: {
      type: 'string',
      description: 'Chat ID of an existing DR session to send a follow-up',
    },
    refresh: {
      type: 'boolean',
      description: 'Re-run the same prompt on an existing DR session (requires --chat)',
    },
    timeout: {
      type: 'string',
      description: `Response timeout in seconds (default: ${String(DEFAULT_TIMEOUT_SEC)})`,
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
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
    ...STREAM_ARG,
  },
  async run({ args }): Promise<void> {
    const v = validateArgs(args);
    if (v === undefined) { return; }

    const { quiet, mode, format, stream, timeoutMs, timeoutSec, exportFormat, exportPath } = v;

    if (args.dryRun === true) {
      const parts = [`mode: ${mode.kind}`, `format: ${format}`, `timeout: ${String(timeoutSec)}s`];
      if (stream) { parts.push('stream: true'); }
      if (mode.kind === 'initial' && mode.filePaths.length > 0) {
        parts.push(`${String(mode.filePaths.length)} file(s)`);
      }
      if (exportFormat !== undefined) { parts.push(`export: ${exportFormat}`); }
      progress(`[dry-run] Would send Deep Research query (${parts.join(', ')})`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      if (stream) { emitState('sending'); }
      const preActionText = await sendQuery(driver, mode, quiet, timeoutMs);

      if (stream) { emitState('researching'); }
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

      // Get clean Markdown text via copy-content when available (best-effort)
      let reportText = result.text;
      if (result.completed) {
        try {
          const markdown = await driver.copyDeepResearchContent();
          if (markdown.length > 0) {
            reportText = markdown;
          }
        } catch (error: unknown) {
          progress(`Copy content failed, using raw text: ${errorMessage(error)}`, quiet);
        }
      }

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
    }, format);
  },
});
