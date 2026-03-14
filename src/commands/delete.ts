import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { FORMAT_ARG, GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, failValidation, progress, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish delete <chat-id>` — delete a conversation.
 * Use `--project "Name"` to delete a project conversation.
 */
const DELETE_ARGS = {
  chatId: {
    type: 'positional' as const,
    description: 'The conversation ID to delete',
    required: true as const,
  },
  project: {
    type: 'string' as const,
    description: 'Project name (required for project conversations)',
  },
  ...GLOBAL_ARGS,
  ...FORMAT_ARG,
};

export const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a conversation by ID',
  },
  args: DELETE_ARGS,
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const isVerbose = args.verbose === true;
    const projectName = args.project;
    const format = validateFormat(args.format);
    if (format === undefined) { return; }

    if (!rejectUnknownFlags(DELETE_ARGS, format)) { return; }

    try {
      assertValidChatId(args.chatId);
    } catch (error: unknown) {
      failValidation(errorMessage(error), format);
      return;
    }

    if (args.dryRun === true) {
      const target = projectName !== undefined
        ? `project conversation ${args.chatId} in "${projectName}"`
        : `conversation ${args.chatId}`;
      progress(`[dry-run] Would delete ${target}`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      if (projectName !== undefined) {
        await driver.navigateToProject(projectName, quiet);
        await driver.deleteProjectConversation(args.chatId, quiet);
      } else {
        await driver.deleteConversation(args.chatId, quiet);
      }
    }, format, { verbose: isVerbose });
  },
});
