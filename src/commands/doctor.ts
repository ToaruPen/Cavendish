import { defineCommand } from 'citty';

import { GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { buildDoctorResult, collectDoctorChecks, formatTextOutput } from '../core/doctor.js';
import { jsonRaw, progress, text } from '../core/output-handler.js';

/**
 * `cavendish doctor` — run all diagnostic checks and report results.
 *
 * Checks CDP connectivity, Chrome profile, CDP endpoint file, Cloudflare status,
 * authentication, prompt textarea, model picker, Google Drive, and GitHub
 * integration. Each check returns pass/fail/skip with actionable suggestions.
 *
 * Use `--json` for structured JSON output (default is human-readable text).
 */
export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Run diagnostic checks on CLI prerequisites, authentication, and integrations',
  },
  args: {
    ...GLOBAL_ARGS,
    json: {
      type: 'boolean' as const,
      description: 'Output results as JSON (default: human-readable text)',
    },
  },
  async run({ args }): Promise<void> {
    if (!rejectUnknownFlags(args)) { return; }

    if (args.dryRun === true) {
      progress('[dry-run] Would run diagnostic checks on CLI prerequisites, auth, and integrations', false);
      return;
    }

    const quiet = args.quiet === true;
    const useJson = args.json === true;
    const checks = await collectDoctorChecks(quiet);
    const result = buildDoctorResult(checks);

    if (useJson) {
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
