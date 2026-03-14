import { fstatSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { errorMessage, failValidation } from './output-handler.js';

/**
 * Global args shared across all commands.
 * Spread into each command's `args` to avoid per-command duplication.
 */
export const GLOBAL_ARGS = {
  quiet: {
    type: 'boolean' as const,
    description: 'Suppress stderr progress messages',
  },
  verbose: {
    type: 'boolean' as const,
    description: 'Enable verbose output for troubleshooting',
  },
  dryRun: {
    type: 'boolean' as const,
    description: 'Validate args and show planned action without executing',
  },
};

/**
 * Format arg for commands that support text/json stdout or JSON-formatted errors.
 * Commands like archive/move that never vary their output or error shape should not include this.
 */
export const FORMAT_ARG = {
  format: {
    type: 'string' as const,
    description: 'Output / error format: json or text (default: json)',
    default: 'json',
  },
};

/**
 * Stream arg for commands that support NDJSON streaming output.
 * When enabled, each chunk / state change is emitted as a single JSON line to stdout.
 */
export const STREAM_ARG = {
  stream: {
    type: 'boolean' as const,
    description: 'Enable streaming output (NDJSON lines to stdout)',
  },
};

/**
 * Extract repeatable string arguments from process.argv.
 * citty does not support array-type args, so we parse manually.
 * Supports both --flag <value> and --flag=<value> forms.
 *
 * @param argv - process.argv to parse
 * @param flag - the flag name without leading dashes (e.g. 'file', 'gdrive', 'github')
 * @param resolvePaths - if true, resolve values as absolute file paths
 */
export function extractRepeatableArgs(
  argv: string[],
  flag: string,
  resolvePaths = false,
): string[] {
  const prefix = `--${flag}=`;
  const exact = `--${flag}`;
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { break; }
    const parsed = parseArgPair(argv, i, prefix, exact, flag);
    if (parsed === undefined) { continue; }
    values.push(resolvePaths ? resolve(parsed.value) : parsed.value);
    i += parsed.skip;
  }
  return values;
}

function parseArgPair(
  argv: string[],
  i: number,
  prefix: string,
  exact: string,
  flag: string,
): { value: string; skip: number } | undefined {
  if (argv[i].startsWith(prefix)) {
    const value = argv[i].slice(prefix.length);
    if (value === '') {
      throw new Error(`--${flag} requires a value`);
    }
    return { value, skip: 0 };
  }
  if (argv[i] === exact) {
    if (i + 1 >= argv.length) {
      throw new Error(`--${flag} requires a value`);
    }
    const value = argv[i + 1];
    if (value === '' || value.startsWith('-')) {
      throw new Error(`--${flag} requires a value, got "${value}"`);
    }
    return { value, skip: 1 };
  }
  return undefined;
}

/**
 * Extract --file arguments from process.argv.
 * Returns resolved absolute paths.
 */
export function extractFileArgs(argv: string[]): string[] {
  return extractRepeatableArgs(argv, 'file', true);
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

/** Extract a repeatable arg or fail with an error message. */
export function extractArgsOrFail(flag: string, format?: 'json' | 'text'): string[] | undefined {
  try {
    return extractRepeatableArgs(process.argv, flag);
  } catch (error: unknown) {
    failValidation(errorMessage(error), format);
    return undefined;
  }
}

// ── Stdin / prompt helpers (shared by ask & deep-research) ───────────

/**
 * Maximum stdin size (1 MB). Enforced during chunked reading so that
 * oversized input is rejected immediately without buffering it all first.
 */
export const STDIN_MAX_BYTES = 1_048_576;

/** Size of the scratch buffer used for chunked stdin reads. */
const STDIN_CHUNK_SIZE = 64 * 1024;

/** Check if an error is an EAGAIN errno (non-blocking fd with no data). */
function isEagainError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as { code: unknown }).code === 'EAGAIN';
}

/**
 * Maximum consecutive EAGAIN retries before giving up.
 * 20 retries × 5 ms = ~100 ms of patience — long enough for inter-chunk
 * gaps in bursty writes, short enough for "no stdin at all" to fail fast.
 */
const EAGAIN_MAX_RETRIES = 20;
const EAGAIN_RETRY_MS = 5;

/** Synchronous sleep using {@link Atomics.wait}. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read all available chunks from fd 0 into `chunks`, tracking total bytes.
 *
 * On non-blocking fds EAGAIN means "no data yet", not EOF. The loop retries
 * up to {@link EAGAIN_MAX_RETRIES} consecutive times with a short sleep so
 * bursty writes are not silently truncated.
 */
function readChunks(chunks: Buffer[], state: { totalBytes: number }): void {
  const scratch = Buffer.allocUnsafe(STDIN_CHUNK_SIZE);
  let consecutiveEagain = 0;
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = readSync(0, scratch, 0, STDIN_CHUNK_SIZE, null);
    } catch (error: unknown) {
      if (isEagainError(error)) {
        consecutiveEagain++;
        if (consecutiveEagain > EAGAIN_MAX_RETRIES) {
          return; // no more data coming
        }
        sleepSync(EAGAIN_RETRY_MS);
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) {
      break;
    }
    consecutiveEagain = 0;
    state.totalBytes += bytesRead;
    if (state.totalBytes > STDIN_MAX_BYTES) {
      throw new Error(
        `Stdin input exceeds ${String(STDIN_MAX_BYTES)} bytes (got ${String(state.totalBytes)}+). Reduce input size or use --file instead.`,
      );
    }
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
  }
}

/**
 * Read piped stdin when running in a non-TTY context.
 * Returns the raw input, or an empty string when stdin is a TTY.
 *
 * Reads in 64 KiB chunks and checks the accumulated size after each chunk,
 * throwing immediately when {@link STDIN_MAX_BYTES} is exceeded. This prevents
 * OOM from multi-GB stdin input.
 */
export function readStdin(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  const state = { totalBytes: 0 };
  try {
    const stat = fstatSync(0);
    const isPipeLike = stat.isFIFO()
      || stat.isFile()
      || (typeof stat.isSocket === 'function' && stat.isSocket());
    if (!isPipeLike) {
      return '';
    }

    readChunks(chunks, state);

    return Buffer.concat(chunks, state.totalBytes).toString('utf-8');
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Stdin input exceeds')) {
      throw error;
    }
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

// ── Batch ID collection (delete / archive / move) ────────────────────

/**
 * The `--stdin` flag for commands that accept chat IDs from stdin.
 */
export const STDIN_ARG = {
  stdin: {
    type: 'boolean' as const,
    description: 'Read chat IDs from stdin (one per line)',
  },
};

/**
 * Known flags that accept a string value (used by {@link extractPositionalIds}
 * to skip the value token after the flag).
 */
const FLAGS_WITH_VALUES = new Set([
  '--project', '--format', '--thinking-effort', '--model',
]);

/**
 * Determine how many argv tokens a flag consumes (0 = not a flag, 1 = boolean
 * flag or `--flag=value`, 2 = `--flag value` for known value-taking flags).
 */
function flagTokenCount(arg: string): number {
  if (!arg.startsWith('--')) { return 0; }
  if (arg.includes('=')) { return 1; }
  return FLAGS_WITH_VALUES.has(arg) ? 2 : 1;
}

/**
 * Find the index of the first argv element (from index 2 onward) that matches
 * the given subcommand token. Returns -1 if not found.
 */
function findSubcommandIndex(argv: readonly string[], subcommand: string): number {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === subcommand) { return i; }
  }
  return -1;
}

/**
 * Extract positional (non-flag) tokens from process.argv after the subcommand.
 *
 * Walks argv starting after the subcommand token, collects non-flag tokens.
 * Flags and their values are skipped.
 *
 * @param subcommand - the subcommand name (e.g. 'delete', 'archive', 'move')
 */
export function extractPositionalIds(subcommand: string): string[] {
  const argv = process.argv;
  const subIdx = findSubcommandIndex(argv, subcommand);
  if (subIdx === -1) { return []; }

  const ids: string[] = [];
  for (let i = subIdx + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { break; }

    const skip = flagTokenCount(arg);
    if (skip > 0) {
      i += skip - 1; // -1 because the loop increments i
      continue;
    }

    ids.push(arg);
  }

  return ids;
}

/**
 * Read chat IDs from stdin (one per line).
 * Returns an empty array if stdin is a TTY or has no data.
 */
function readStdinIds(): string[] {
  const raw = readStdin();
  if (raw.length === 0) { return []; }
  return raw.split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Collect chat IDs from positional args and optionally stdin.
 * Deduplicates IDs while preserving first-seen order.
 *
 * @param subcommand - the subcommand name to locate positional args after
 * @param useStdin - whether to also read IDs from stdin
 */
export function collectChatIds(subcommand: string, useStdin: boolean): string[] {
  const ids: string[] = extractPositionalIds(subcommand);

  if (useStdin) {
    ids.push(...readStdinIds());
  }

  // Deduplicate while preserving order
  return [...new Set(ids)];
}

// ── Unknown-flag detection ───────────────────────────────────────────

/** Convert a camelCase string to kebab-case. */
function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Check process.argv for flags not declared in the command's args definition.
 * Ignores positional args (tokens not starting with `--`) and `--` separator.
 * Returns the first unknown flag found, or undefined if all flags are known.
 *
 * @param argv - process.argv to scan
 * @param declaredArgKeys - keys from the command's declared args
 *   (e.g. Object.keys(args) from citty's run callback, or from the args definition)
 */
export function findUnknownFlag(
  argv: string[],
  declaredArgKeys: string[],
): string | undefined {
  // Build the set of known flag names (both camelCase and kebab-case).
  // For each key we also add --no-<key> / --no-<kebab> because citty
  // supports boolean negation (e.g. --no-verbose sets verbose to false).
  // Adding --no-* for non-boolean keys is harmless — citty itself will
  // reject them — but omitting --no-* for boolean keys would cause a
  // false "unknown option" error.
  const knownFlags = new Set<string>();
  for (const key of declaredArgKeys) {
    knownFlags.add(`--${key}`);
    knownFlags.add(`--no-${key}`);
    // citty also accepts kebab-case (e.g., --dry-run for dryRun)
    const kebab = camelToKebab(key);
    knownFlags.add(`--${kebab}`);
    knownFlags.add(`--no-${kebab}`);
  }

  // Walk argv, skipping the node binary and script path.
  // Positional args and subcommand names don't start with '--' so they are ignored.
  for (const arg of argv.slice(2)) {
    if (arg === '--') { break; }
    if (!arg.startsWith('--')) { continue; }

    const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!knownFlags.has(flagName)) {
      return flagName;
    }
  }
  return undefined;
}

/**
 * Reject unknown flags by checking process.argv against declared args.
 * Call at the start of each command's run() before any other validation.
 *
 * IMPORTANT: Pass the command's **args definition** object (the static object
 * with `type`/`description` fields), NOT citty's runtime parsed `args`.
 * citty adds undeclared flags to the parsed args, so using parsed args
 * would make every flag appear "known" and bypass the check entirely.
 *
 * Positional args (type: 'positional') are automatically excluded from the
 * known-flag whitelist so that their kebab-case variants (e.g. --chat-id
 * for chatId) are not incorrectly accepted as valid flags.
 *
 * @param declaredArgs - the command's args definition object (e.g. ASK_ARGS)
 * @param format - output format for error messages
 * @returns true if all flags are known, false if an unknown flag was found
 */
export function rejectUnknownFlags(
  declaredArgs: Record<string, unknown>,
  format?: 'json' | 'text',
): boolean {
  // Auto-detect positional keys from the args definition and exclude them
  // so that their flag forms (e.g. --chat-id for chatId) are not accepted.
  const flagKeys = Object.keys(declaredArgs).filter(k => {
    const def = declaredArgs[k];
    return !(typeof def === 'object' && def !== null && 'type' in def && (def as { type: string }).type === 'positional');
  });
  const unknown = findUnknownFlag(process.argv, flagKeys);
  if (unknown !== undefined) {
    failValidation(`Unknown option: ${unknown}`, format);
    return false;
  }
  return true;
}

/**
 * Validate --file arguments from process.argv.
 * Returns resolved absolute paths, or undefined on validation error.
 */
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

/**
 * Parse and validate --upload-timeout. Returns milliseconds on success,
 * undefined when not provided, or null on validation failure.
 */
export function parseUploadTimeout(
  raw: string | undefined,
  format: 'json' | 'text',
): number | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) {
    failValidation(`--upload-timeout must be a positive number, got "${raw}"`, format);
    return null;
  }
  return sec * 1000;
}
