import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import { CHATGPT_BASE_URL } from '../constants/selectors.js';
import { CAVENDISH_DIR, CDP_BASE_URL, CDP_PORT, CHROME_PROFILE_DIR } from '../core/browser-manager.js';
import { FORMAT_ARG, GLOBAL_ARGS } from '../core/cli-args.js';
import { jsonRaw, progress, text, validateFormat } from '../core/output-handler.js';

const CONFIG_FILE = join(CAVENDISH_DIR, 'config.json');

interface StatusCheck {
  ok: boolean;
  detail: string;
}

interface StatusResult {
  cdp: StatusCheck & { chrome?: string };
  chatgpt: StatusCheck;
  profile: StatusCheck & { path: string };
  config: StatusCheck & { path: string };
}

/**
 * Check Chrome CDP connectivity and return version info.
 */
async function checkCdp(): Promise<StatusResult['cdp']> {
  try {
    const res = await fetch(`${CDP_BASE_URL}/json/version`);
    if (res.ok) {
      const data = (await res.json()) as { Browser?: string };
      const chrome = data.Browser ?? 'unknown';
      return { ok: true, detail: `Connected (${chrome})`, chrome };
    }
    return { ok: false, detail: `HTTP ${String(res.status)}` };
  } catch {
    return {
      ok: false,
      detail: `Not running (start Chrome with --remote-debugging-port=${String(CDP_PORT)})`,
    };
  }
}

/**
 * Check if a ChatGPT tab is open and appears to be logged in.
 * Uses CDP /json/list to avoid a full Playwright connection.
 */
async function checkChatGPT(): Promise<StatusCheck> {
  try {
    const res = await fetch(`${CDP_BASE_URL}/json/list`);
    if (!res.ok) {
      return { ok: false, detail: 'Failed to query open tabs' };
    }
    const pages = (await res.json()) as { url: string }[];
    const chatgptPages = pages.filter((p) => p.url.startsWith(CHATGPT_BASE_URL));
    if (chatgptPages.length === 0) {
      return { ok: false, detail: 'No ChatGPT tab open' };
    }
    const loggedIn = chatgptPages.some((p) => !p.url.includes('/auth/'));
    return loggedIn
      ? { ok: true, detail: 'Logged in' }
      : { ok: false, detail: 'Not logged in (login page detected)' };
  } catch {
    return { ok: false, detail: 'Failed to check' };
  }
}

function chatgptIcon(cdpOk: boolean, chatgptOk: boolean): string {
  if (!cdpOk) {return '-';}
  return chatgptOk ? '✓' : '✗';
}

function formatTextOutput(result: StatusResult): string[] {
  const cdpIcon = result.cdp.ok ? '✓' : '✗';
  return [
    `Chrome CDP:    ${cdpIcon} ${result.cdp.detail}`,
    `ChatGPT:       ${chatgptIcon(result.cdp.ok, result.chatgpt.ok)} ${result.chatgpt.detail}`,
    `Profile:       ${result.profile.path} (${result.profile.detail})`,
    `Config:        ${result.config.path} (${result.config.detail})`,
  ];
}

async function collectStatus(): Promise<StatusResult> {
  const cdp = await checkCdp();

  const chatgpt: StatusCheck = cdp.ok
    ? await checkChatGPT()
    : { ok: false, detail: 'skipped, no Chrome connection' };

  const profileExists = existsSync(CHROME_PROFILE_DIR);
  const configExists = existsSync(CONFIG_FILE);

  return {
    cdp,
    chatgpt,
    profile: { ok: profileExists, detail: profileExists ? 'found' : 'not found', path: CHROME_PROFILE_DIR },
    config: { ok: configExists, detail: configExists ? 'found' : 'not found', path: CONFIG_FILE },
  };
}

/**
 * `cavendish status` — check CLI prerequisites and environment status.
 */
export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Check CLI prerequisites and environment status',
  },
  args: {
    ...GLOBAL_ARGS,
    ...FORMAT_ARG,
  },
  async run({ args }): Promise<void> {
    const format = validateFormat(args.format);
    if (format === undefined) {return;}

    if (args.dryRun === true) {
      progress('[dry-run] Would check CLI prerequisites and environment status', false);
      return;
    }

    const result = await collectStatus();

    if (format === 'json') {
      jsonRaw(result);
    } else {
      for (const line of formatTextOutput(result)) {
        text(line);
      }
    }

    if (!result.cdp.ok || !result.chatgpt.ok || !result.profile.ok) {
      process.exitCode = 1;
    }
  },
});
