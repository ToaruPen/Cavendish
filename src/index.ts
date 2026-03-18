import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineCommand, runMain } from 'citty';

import { archiveCommand } from './commands/archive.js';
import { askCommand } from './commands/ask.js';
import { deepResearchCommand } from './commands/deep-research.js';
import { deleteCommand } from './commands/delete.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { jobsCommand } from './commands/jobs.js';
import { listCommand } from './commands/list.js';
import { moveCommand } from './commands/move.js';
import { projectsCommand } from './commands/projects.js';
import { readCommand } from './commands/read.js';
import { reportCommand } from './commands/report.js';
import { statusCommand } from './commands/status.js';
import { registerSignalHandlers } from './core/shutdown.js';

declare const __VERSION__: string;

const main = defineCommand({
  meta: {
    name: 'cavendish',
    version: __VERSION__,
    description:
      'Playwright-based CLI that automates ChatGPT Web UI for coding agents',
  },
  subCommands: {
    archive: archiveCommand,
    ask: askCommand,
    'deep-research': deepResearchCommand,
    delete: deleteCommand,
    doctor: doctorCommand,
    init: initCommand,
    jobs: jobsCommand,
    list: listCommand,
    move: moveCommand,
    projects: projectsCommand,
    read: readCommand,
    report: reportCommand,
    status: statusCommand,
  },
});

// Only execute CLI when run directly (not when imported as a module).
// Use realpathSync on both sides to resolve symlinks from global npm
// installs (e.g. /usr/local/bin/cavendish → ~/.npm/.../dist/index.mjs).
let currentFile: string;
try {
  currentFile = realpathSync(fileURLToPath(import.meta.url));
} catch {
  currentFile = fileURLToPath(import.meta.url);
}
let entryFile: string;
try {
  entryFile = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {
  // argv[1] may not be a real path (e.g. Node invoked via stdin with `-`)
  entryFile = '';
}
const isDirectRun = entryFile === currentFile;

if (isDirectRun) {
  registerSignalHandlers();
  void runMain(main);
}
