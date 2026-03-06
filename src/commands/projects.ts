import { defineCommand } from 'citty';

import { fail, outputList, progress, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish projects` — list projects or project chats.
 */
export const projectsCommand = defineCommand({
  meta: {
    name: 'projects',
    description: 'List ChatGPT projects or chats within a project',
  },
  args: {
    name: {
      type: 'string',
      description: 'Project name to filter or navigate to',
    },
    chats: {
      type: 'boolean',
      description: 'List chats within the specified project (requires --name)',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress stderr progress messages',
    },
    format: {
      type: 'string',
      description: 'Output format: json or text (default: json)',
      default: 'json',
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const format = validateFormat(args.format);
    if (format === undefined) {return;}
    const projectName = args.name;
    const showChats = args.chats === true;

    if (showChats && projectName === undefined) {
      fail('--chats requires --name. Use: cavendish projects --name "Project" --chats');
      return;
    }

    await withDriver(quiet, async (driver) => {
      if (projectName !== undefined && showChats) {
        await driver.navigateToProject(projectName, quiet);
        progress('Fetching project conversations...', quiet);
        const conversations = await driver.getProjectConversationList(quiet);
        progress(`Found ${String(conversations.length)} conversation(s)`, quiet);
        outputList(conversations, format);
      } else {
        progress('Fetching project list...', quiet);
        let projects = await driver.getProjectList(quiet);
        if (projectName !== undefined) {
          const lower = projectName.toLowerCase();
          projects = projects.filter((p) => p.name.toLowerCase().includes(lower));
        }
        progress(`Found ${String(projects.length)} project(s)`, quiet);
        outputList(projects, format);
      }
    });
  },
});
