import { defineCommand } from 'citty';

import { FORMAT_ARG, GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { failValidation, outputList, progress, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

export function validateProjectArgs(
  showChats: boolean,
  createProject: boolean,
  projectName: string | undefined,
): string | null {
  if (showChats && createProject) {
    return '--chats and --create are mutually exclusive. Use one at a time.';
  }
  if (showChats && projectName === undefined) {
    return '--chats requires --name. Use: cavendish projects --name "Project" --chats';
  }
  if (createProject && projectName === undefined) {
    return '--create requires --name. Use: cavendish projects --create --name "Project"';
  }
  return null;
}

/**
 * `cavendish projects` — list projects, project chats, or create a project.
 */
export const projectsCommand = defineCommand({
  meta: {
    name: 'projects',
    description: 'List ChatGPT projects, chats within a project, or create a project',
  },
  args: {
    name: {
      type: 'string',
      description: 'Project name to filter, navigate to, or create',
    },
    chats: {
      type: 'boolean',
      description: 'List chats within the specified project (requires --name)',
    },
    create: {
      type: 'boolean',
      description: 'Create a new project (requires --name)',
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

    const projectName = args.name;
    const showChats = args.chats === true;
    const createProject = args.create === true;

    const validationError = validateProjectArgs(showChats, createProject, projectName);
    if (validationError !== null) {
      failValidation(validationError, format);
      return;
    }

    if (args.dryRun === true) {
      if (createProject) {
        progress(`[dry-run] Would create project "${String(projectName)}"`, false);
      } else if (showChats && projectName !== undefined) {
        progress(`[dry-run] Would list chats in project "${projectName}" (format: ${format})`, false);
      } else {
        const filter = projectName !== undefined ? ` (filter: "${projectName}")` : '';
        progress(`[dry-run] Would list projects${filter} (format: ${format})`, false);
      }
      return;
    }

    await withDriver(quiet, async (driver) => {
      if (createProject && projectName !== undefined) {
        await driver.createProject(projectName, quiet);
      } else if (projectName !== undefined && showChats) {
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
    }, format, { verbose: isVerbose });
  },
});
