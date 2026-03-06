/**
 * OutputHandler — agent-oriented output module.
 *
 * - stdout: structured data only (JSON or plain text)
 * - stderr: progress / log messages
 */

export interface ResponsePayload {
  content: string;
  model?: string;
  timeoutSec?: number;
  timestamp: string;
  partial: boolean;
}

/**
 * Write a structured JSON response to stdout.
 */
export function json(
  content: string,
  metadata?: { model?: string; partial?: boolean; timeoutSec?: number },
): void {
  const payload: ResponsePayload = {
    content,
    model: metadata?.model,
    timeoutSec: metadata?.timeoutSec,
    timestamp: new Date().toISOString(),
    partial: metadata?.partial ?? false,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Write arbitrary JSON data to stdout.
 * Use for list/array output where ResponsePayload is not appropriate.
 */
export function jsonRaw(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
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
 * Validate --format value. Returns the narrowed type, or undefined on error.
 */
export function validateFormat(format: string): 'json' | 'text' | undefined {
  if (format === 'json' || format === 'text') {
    return format;
  }
  fail(`--format must be "json" or "text", got "${format}"`);
  return undefined;
}
