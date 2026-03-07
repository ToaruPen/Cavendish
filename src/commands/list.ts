import { defineCommand } from 'citty';

import { FORMAT_ARG, GLOBAL_ARGS } from '../core/cli-args.js';
import { outputList, progress, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish list` — list conversations from the ChatGPT sidebar.
 */
export const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List conversations from the ChatGPT sidebar',
  },
  args: {
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const format = validateFormat(args.format);
    if (format === undefined) {return;}

    if (args.dryRun === true) {
      progress(`[dry-run] Would list conversations (format: ${format})`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      progress('Fetching conversation list...', quiet);
      const conversations = await driver.getConversationList(quiet);
      progress(`Found ${String(conversations.length)} conversation(s)`, quiet);
      outputList(conversations, format);
    }, format);
  },
});
