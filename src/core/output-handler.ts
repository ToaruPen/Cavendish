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
