/**
 * OutputHandler — agent-oriented output module.
 *
 * - stdout: structured data only (JSON or plain text)
 * - stderr: progress / log messages / structured errors (JSON mode)
 */

import { CavendishError, EXIT_CODES, classifyError } from './errors.js';

export interface ResponsePayload {
  content: string;
  model?: string;
  chatId?: string;
  url?: string;
  project?: string;
  timeoutSec?: number;
  timestamp: string;
  partial: boolean;
}

/**
 * NDJSON event types emitted during streaming output.
 *
 * - chunk:  incremental response text (cumulative snapshot)
 * - state:  lifecycle state change (e.g. Deep Research phases)
 * - final:  the complete response (same payload as non-streaming JSON output)
 */
export type NdjsonEventType = 'chunk' | 'state' | 'final';

export interface NdjsonEvent {
  type: NdjsonEventType;
  content: string;
  timestamp: string;
  /** Present on 'state' events to identify the lifecycle phase. */
  state?: string;
  /** Present on 'final' events. */
  model?: string;
  /** Present on 'final' events. */
  chatId?: string;
  /** Present on 'final' events. */
  url?: string;
  /** Present on 'final' events. */
  project?: string;
  /** Present on 'final' events. */
  partial?: boolean;
  /** Present on 'final' events. */
  timeoutSec?: number;
}

/**
 * Write a structured JSON response to stdout.
 */
export function json(
  content: string,
  metadata?: {
    model?: string;
    chatId?: string;
    url?: string;
    project?: string;
    partial?: boolean;
    timeoutSec?: number;
  },
): void {
  const payload: ResponsePayload = {
    content,
    model: metadata?.model,
    chatId: metadata?.chatId,
    url: metadata?.url,
    project: metadata?.project,
    timeoutSec: metadata?.timeoutSec,
    timestamp: new Date().toISOString(),
    partial: metadata?.partial ?? false,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Write arbitrary JSON data to stdout.
 * Use for list/array output where ResponsePayload is not appropriate.
 */
export function jsonRaw(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Output a list of { id, ... } items as JSON or tab-separated text.
 * Resolves the display label from `title` or `name` property.
 */
export function outputList(
  items: readonly { id: string; title?: string; name?: string }[],
  format: 'json' | 'text',
): void {
  if (format === 'text') {
    for (const item of items) {
      const label = item.title ?? item.name ?? '';
      text(`${item.id}\t${label}`);
    }
  } else {
    jsonRaw(items);
  }
}

/**
 * Write plain text to stdout.
 */
export function text(content: string): void {
  process.stdout.write(`${content}\n`);
}

/**
 * Write a single NDJSON event line to stdout.
 * Each call produces one JSON object followed by a newline.
 */
export function ndjsonChunk(event: NdjsonEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Emit an NDJSON 'chunk' event (incremental response text).
 */
export function emitChunk(content: string): void {
  ndjsonChunk({ type: 'chunk', content, timestamp: new Date().toISOString() });
}

/**
 * Emit an NDJSON 'state' event (lifecycle phase change).
 */
export function emitState(state: string, content = ''): void {
  ndjsonChunk({ type: 'state', content, state, timestamp: new Date().toISOString() });
}

/**
 * Emit an NDJSON 'final' event (complete response).
 */
export function emitFinal(
  content: string,
  metadata?: { model?: string; chatId?: string; url?: string; project?: string; partial?: boolean; timeoutSec?: number },
): void {
  ndjsonChunk({
    type: 'final',
    content,
    model: metadata?.model,
    chatId: metadata?.chatId,
    url: metadata?.url,
    project: metadata?.project,
    partial: metadata?.partial ?? false,
    timeoutSec: metadata?.timeoutSec,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Write a progress / log message to stderr.
 * Suppressed when `quiet` is true.
 */
export function progress(message: string, quiet = false): void {
  if (quiet) {
    return;
  }
  process.stderr.write(`[cavendish] ${message}\n`);
}

/**
 * Write a verbose diagnostic message to stderr.
 * Only emitted when `enabled` is true — intended for `--verbose` troubleshooting.
 */
export function verbose(message: string, enabled: boolean): void {
  if (!enabled) {
    return;
  }
  process.stderr.write(`[cavendish:verbose] ${message}\n`);
}

/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Log an error to stderr and set exit code 1.
 * Returns undefined for convenient early-return chaining.
 */
export function fail(message: string): undefined {
  progress(`Error: ${message}`, false);
  process.exitCode = 1;
  return undefined;
}

/**
 * Report a structured error with category-specific exit code.
 *
 * - When `format` is `'json'`: writes a JSON error payload to stderr.
 * - When `format` is `'text'` (or omitted): writes a human-readable message to stderr.
 *
 * Automatically classifies raw errors into the appropriate category.
 * Sets the process exit code to the category-specific value.
 */
export function failStructured(error: unknown, format?: 'json' | 'text'): undefined {
  const classified: CavendishError = classifyError(error);
  const exitCode = EXIT_CODES[classified.category];

  if (format === 'json') {
    process.stderr.write(`${JSON.stringify(classified.toPayload())}\n`);
  } else {
    progress(`Error: ${classified.message}`, false);
    progress(`Action: ${classified.action}`, false);
  }

  process.exitCode = exitCode;
  return undefined;
}

/**
 * Report a validation error using the appropriate output mode.
 *
 * When `format` is `'json'`, emits a structured JSON error to stderr.
 * When `format` is `'text'` (or undefined), falls back to plain-text `fail()`.
 *
 * Returns undefined for convenient early-return chaining.
 */
export function failValidation(message: string, format?: 'json' | 'text'): undefined {
  if (format === 'json') {
    const err = new CavendishError(message, 'unknown');
    process.stderr.write(`${JSON.stringify(err.toPayload())}\n`);
    process.exitCode = EXIT_CODES.unknown;
  } else {
    fail(message);
  }
  return undefined;
}

/**
 * Validate --format value. Returns the narrowed type, or undefined on error.
 */
export function validateFormat(format: string): 'json' | 'text' | undefined {
  if (format === 'json' || format === 'text') {
    return format;
  }
  fail(`--format must be "json" or "text", got "${format}"`);
  return undefined;
}
