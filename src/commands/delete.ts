import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { FORMAT_ARG, GLOBAL_ARGS, STDIN_ARG, collectChatIds, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, failValidation, progress, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish delete <id...>` — delete one or more conversations.
 * Use `--project "Name"` to delete project conversations.
 * Use `--stdin` to read IDs from stdin (one per line).
 */
const DELETE_ARGS = {
  chatId: {
    type: 'positional' as const,
    description: 'Conversation ID(s) to delete (supports multiple)',
    required: false as const,
  },
  project: {
    type: 'string' as const,
    description: 'Project name (required for project conversations)',
  },
  ...GLOBAL_ARGS,
  ...FORMAT_ARG,
  ...STDIN_ARG,
};

export const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete one or more conversations by ID',
  },
  args: DELETE_ARGS,
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const isVerbose = args.verbose === true;
    const projectName = args.project;
    const format = validateFormat(args.format);
    if (format === undefined) { return; }

    if (!rejectUnknownFlags(DELETE_ARGS, format)) { return; }

    let ids: string[];
    try {
      ids = collectChatIds('delete', args.stdin === true);
    } catch (error: unknown) {
      failValidation(errorMessage(error), format);
      return;
    }

    if (ids.length === 0) {
      failValidation('No conversation IDs provided. Pass IDs as arguments or use --stdin.', format);
      return;
    }

    // Validate all IDs before starting
    for (const id of ids) {
      try {
        assertValidChatId(id);
      } catch (error: unknown) {
        failValidation(errorMessage(error), format);
        return;
      }
    }

    if (args.dryRun === true) {
      for (let i = 0; i < ids.length; i++) {
        const target = projectName !== undefined
          ? `project conversation ${ids[i]} in "${projectName}"`
          : `conversation ${ids[i]}`;
        progress(`[dry-run] [${String(i + 1)}/${String(ids.length)}] Would delete ${target}`, false);
      }
      return;
    }

    await withDriver(quiet, async (driver) => {
      let failed = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const label = `[${String(i + 1)}/${String(ids.length)}]`;
        try {
          progress(`${label} Deleting: ${id}`, quiet);
          if (projectName !== undefined) {
            // Re-navigate per deletion: the project page DOM changes after each delete.
            await driver.navigateToProject(projectName, quiet);
            await driver.deleteProjectConversation(id, quiet);
          } else {
            await driver.deleteConversation(id, quiet);
          }
        } catch (error: unknown) {
          progress(`${label} Failed to delete ${id}: ${errorMessage(error)}`, false);
          failed++;
        }
      }
      if (ids.length > 1) {
        progress(
          `Completed: ${String(ids.length - failed)}/${String(ids.length)} (${String(failed)} failed)`,
          quiet,
        );
      }
      if (failed > 0) {
        process.exitCode = 1;
      }
    }, format, { verbose: isVerbose });
  },
});
