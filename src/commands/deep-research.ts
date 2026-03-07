import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import type { ChatGPTDriver, DeepResearchExportFormat } from '../core/chatgpt-driver.js';
import { errorMessage, fail, json, progress, text, validateFormat } from '../core/output-handler.js';
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
  timeoutMs: number;
  timeoutSec: number;
  exportFormat: DeepResearchExportFormat | undefined;
  exportPath: string | undefined;
}

function validateTimeout(raw: unknown): number | undefined {
  const sec = raw !== undefined ? Number(raw) : DEFAULT_TIMEOUT_SEC;
  if (!Number.isFinite(sec) || sec <= 0) {
    fail(`--timeout must be a positive number, got "${String(raw)}"`);
    return undefined;
  }
  return sec;
}

function validateExport(
  rawExport: unknown,
  rawExportPath: unknown,
): { exportFormat: DeepResearchExportFormat | undefined; exportPath: string | undefined } | undefined {
  const exportFormat = rawExport as DeepResearchExportFormat | undefined;
  if (exportFormat !== undefined && !VALID_EXPORT_FORMATS.includes(exportFormat)) {
    fail(`--export must be one of: ${VALID_EXPORT_FORMATS.join(', ')}. Got "${exportFormat}"`);
    return undefined;
  }
  if (exportFormat === undefined && rawExportPath !== undefined) {
    fail('--exportPath requires --export (e.g. --export markdown --exportPath report.md)');
    return undefined;
  }
  return { exportFormat, exportPath: rawExportPath as string | undefined };
}

function validateFlagConflicts(args: Record<string, unknown>): boolean {
  const isFollowUp = args.chat !== undefined;
  const isRefresh = args.refresh === true;

  if (isRefresh && !isFollowUp) {
    fail('--refresh requires --chat (specify the DR session to refresh)');
    return false;
  }
  if (isFollowUp && args.file !== undefined) {
    fail('--file is not supported with --chat');
    return false;
  }
  if (isRefresh && args.prompt !== undefined && args.prompt !== '') {
    fail('--refresh re-runs the existing prompt; do not provide a new prompt');
    return false;
  }
  return true;
}

function resolveRunMode(
  args: Record<string, unknown>,
  stdinData: string,
  filePaths: string[],
): RunMode | undefined {
  const isFollowUp = args.chat !== undefined;
  const isRefresh = args.refresh === true;
  const chatId = args.chat as string;

  if (isRefresh) {
    if (stdinData.length > 0) {
      fail('--refresh does not accept stdin input');
      return undefined;
    }
    return { kind: 'refresh', chatId };
  }

  // Prompt can come from positional arg, stdin, or both (buildPrompt merges them).
  // Require at least one source.
  const prompt = buildPrompt(args.prompt as string | undefined ?? '', stdinData);
  if (prompt.length === 0) {
    fail('A prompt is required (positional argument or stdin)');
    return undefined;
  }

  if (isFollowUp) {
    return { kind: 'followup', chatId, prompt };
  }

  return { kind: 'initial', prompt, filePaths };
}

function validateArgs(args: Record<string, unknown>): ValidatedArgs | undefined {
  const quiet = args.quiet === true;

  // Validate flags, format, timeout, export, and file args BEFORE reading
  // stdin so obviously invalid invocations fail fast without blocking on EOF.
  if (!validateFlagConflicts(args)) { return undefined; }

  const format = validateFormat(args.format as string);
  if (format === undefined) { return undefined; }

  const timeoutSec = validateTimeout(args.timeout);
  if (timeoutSec === undefined) { return undefined; }

  const exp = validateExport(args.export, args.exportPath);
  if (exp === undefined) { return undefined; }

  // Validate file args before stdin (--file missing.txt should fail fast)
  let filePaths: string[] = [];
  if (args.chat === undefined) {
    const validated = validateFileArgs();
    if (validated === undefined) { return undefined; }
    filePaths = validated;
  }

  let stdinData: string;
  try {
    stdinData = readStdin();
  } catch (error: unknown) {
    fail(errorMessage(error));
    return undefined;
  }

  const mode = resolveRunMode(args, stdinData, filePaths);
  if (mode === undefined) { return undefined; }

  return {
    quiet,
    mode,
    format,
    timeoutMs: timeoutSec * 1000,
    timeoutSec,
    exportFormat: exp.exportFormat,
    exportPath: exp.exportPath,
  };
}

async function sendQuery(driver: ChatGPTDriver, mode: RunMode, quiet: boolean): Promise<void> {
  switch (mode.kind) {
    case 'refresh':
      progress('Refreshing Deep Research session...', quiet);
      await driver.refreshDeepResearch(mode.chatId, quiet);
      break;
    case 'followup':
      progress('Sending Deep Research follow-up...', quiet);
      await driver.sendDeepResearchFollowUp(mode.chatId, mode.prompt, quiet);
      break;
    case 'initial':
      await driver.navigateToDeepResearch(quiet);
      if (mode.filePaths.length > 0) {
        await driver.attachFiles(mode.filePaths, quiet);
      }
      progress('Sending Deep Research query...', quiet);
      await driver.sendDeepResearchMessage(mode.prompt);
      break;
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
    description: 'Send a prompt to ChatGPT Deep Research and return the report',
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
    export: {
      type: 'string',
      description: 'Export report to file: markdown, word, or pdf (e.g. --export markdown)',
    },
    exportPath: {
      type: 'string',
      description: 'Path to save exported file (default: ./deep-research-report.{ext})',
    },
  },
  async run({ args }): Promise<void> {
    const v = validateArgs(args);
    if (v === undefined) { return; }

    const { quiet, mode, format, timeoutMs, timeoutSec, exportFormat, exportPath } = v;

    await withDriver(quiet, async (driver) => {
      await sendQuery(driver, mode, quiet);

      const result = await driver.waitForDeepResearchResponse({
        timeout: timeoutMs,
        quiet,
      });

      const chatId = resolveChatId(driver, mode, quiet);
      if (chatId !== undefined) {
        progress(`Chat ID: ${chatId}`, quiet);
      }

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

      if (format === 'text') {
        text(reportText);
      } else {
        json(reportText, {
          model: 'deep-research',
          chatId,
          partial: !result.completed,
          timeoutSec,
        });
      }
    });
  },
});
