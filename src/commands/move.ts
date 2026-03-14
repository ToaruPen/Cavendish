import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS, STDIN_ARG, collectChatIds, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish move <id...> --project "Name"` — move one or more conversations to a project.
 * Use `--stdin` to read IDs from stdin (one per line).
 */
const MOVE_ARGS = {
  chatId: {
    type: 'positional' as const,
    description: 'Conversation ID(s) to move (supports multiple)',
    required: false as const,
  },
  project: {
    type: 'string' as const,
    description: 'Target project name',
    required: true as const,
  },
  ...GLOBAL_ARGS,
  ...STDIN_ARG,
};

export const moveCommand = defineCommand({
  meta: {
    name: 'move',
    description: 'Move one or more conversations to a project',
  },
  args: MOVE_ARGS,
  async run({ args }): Promise<void> {
    if (!rejectUnknownFlags(MOVE_ARGS)) { return; }

    const quiet = args.quiet === true;
    const isVerbose = args.verbose === true;

    const ids = collectChatIds('move', args.stdin === true);

    if (ids.length === 0) {
      fail('No conversation IDs provided. Pass IDs as arguments or use --stdin.');
      return;
    }

    // Validate all IDs before starting
    for (const id of ids) {
      try {
        assertValidChatId(id);
      } catch (error: unknown) {
        fail(errorMessage(error));
        return;
      }
    }

    if (args.dryRun === true) {
      for (let i = 0; i < ids.length; i++) {
        progress(
          `[dry-run] [${String(i + 1)}/${String(ids.length)}] Would move conversation ${ids[i]} to project "${args.project}"`,
          false,
        );
      }
      return;
    }

    await withDriver(quiet, async (driver) => {
      let failed = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const label = `[${String(i + 1)}/${String(ids.length)}]`;
        try {
          progress(`${label} Moving: ${id} → "${args.project}"`, quiet);
          await driver.moveToProject(id, args.project, quiet);
        } catch (error: unknown) {
          progress(`${label} Failed to move ${id}: ${errorMessage(error)}`, false);
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
    }, undefined, { verbose: isVerbose });
  },
});
