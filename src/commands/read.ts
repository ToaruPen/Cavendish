import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import type { ConversationMessage } from '../core/chatgpt-driver.js';
import { FORMAT_ARG, GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, failValidation, jsonRaw, progress, text, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/** Structured output for the read command in JSON mode. */
interface ReadPayload {
  chatId: string;
  url: string;
  messages: readonly ConversationMessage[];
  timestamp: string;
}

/**
 * Format conversation messages as human-readable text.
 * Each message is prefixed with its role label.
 */
function formatAsText(messages: readonly ConversationMessage[]): string {
  return messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join('\n\n');
}

/**
 * `cavendish read <chat-id>` — read messages from an existing conversation.
 */
export const readCommand = defineCommand({
  meta: {
    name: 'read',
    description: 'Read messages from an existing ChatGPT conversation',
  },
  args: {
    chatId: {
      type: 'positional',
      description: 'The conversation ID to read',
      required: true,
    },
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const isVerbose = args.verbose === true;
    const format = validateFormat(args.format);
    if (format === undefined) {return;}

    if (!rejectUnknownFlags(args, format)) {return;}

    try {
      assertValidChatId(args.chatId);
    } catch (error: unknown) {
      failValidation(errorMessage(error), format);
      return;
    }

    if (args.dryRun === true) {
      progress(`[dry-run] Would read conversation ${args.chatId} (format: ${format})`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      const messages = await driver.readConversation(args.chatId, quiet);
      const chatId: string = args.chatId;

      if (format === 'text') {
        text(formatAsText(messages));
      } else {
        const payload: ReadPayload = {
          chatId,
          url: driver.getCurrentUrl(),
          messages,
          timestamp: new Date().toISOString(),
        };
        jsonRaw(payload);
      }
    }, format, { verbose: isVerbose });
  },
});
