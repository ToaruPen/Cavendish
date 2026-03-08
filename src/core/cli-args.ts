import { statSync } from 'node:fs';
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
 * Format arg for commands that produce structured output.
 * Commands like archive/delete/move that have no formatted output should not include this.
 */
export const FORMAT_ARG = {
  format: {
    type: 'string' as const,
    description: 'Output format: json or text (default: json)',
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
