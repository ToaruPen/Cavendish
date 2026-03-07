import { defineCommand } from 'citty';

import { FORMAT_ARG, GLOBAL_ARGS } from '../core/cli-args.js';
import { buildDoctorResult, collectDoctorChecks, formatTextOutput } from '../core/doctor.js';
import { jsonRaw, progress, text, validateFormat } from '../core/output-handler.js';

/**
 * `cavendish status` — doctor-style health check for CLI prerequisites,
 * ChatGPT authentication, and DOM selector availability.
 */
export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Doctor-style health check for CLI prerequisites and ChatGPT environment',
  },
  args: {
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
  },
  async run({ args }): Promise<void> {
    const format = validateFormat(args.format);
    if (format === undefined) {return;}

    if (args.dryRun === true) {
      progress('[dry-run] Would run doctor checks on CLI prerequisites and ChatGPT environment', false);
      return;
    }

    const quiet = args.quiet === true;
    const checks = await collectDoctorChecks(quiet);
    const result = buildDoctorResult(checks);

    if (format === 'json') {
      jsonRaw(result);
    } else {
      for (const line of formatTextOutput(result)) {
        text(line);
      }
    }

    if (result.summary.fail > 0) {
      process.exitCode = 1;
    }
  },
});
