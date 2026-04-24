import { describe, expect, it } from 'vitest';

import { MENU_LABELS, SELECTORS } from '../src/constants/selectors.js';
import {
  type CheckStatus,
  type DoctorCheck,
  buildDoctorResult,
  buildSummary,
  checkGoogleDrive,
  formatTextOutput,
} from '../src/core/doctor.js';

describe('buildSummary', () => {
  it('counts pass/fail/skip correctly', () => {
    const checks: DoctorCheck[] = [
      { name: 'chrome_cdp', status: 'pass', detail: 'Connected' },
      { name: 'profile_dir', status: 'pass', detail: '/path' },
      { name: 'cdp_endpoint', status: 'skip', detail: 'not found' },
      { name: 'cloudflare', status: 'fail', detail: 'blocked' },
    ];

    const summary = buildSummary(checks);

    expect(summary).toEqual({
      total: 4,
      pass: 2,
      fail: 1,
      skip: 1,
    });
  });

  it('returns all zeros for empty checks', () => {
    const summary = buildSummary([]);

    expect(summary).toEqual({ total: 0, pass: 0, fail: 0, skip: 0 });
  });
});

describe('buildDoctorResult', () => {
  it('combines checks and summary', () => {
    const checks: DoctorCheck[] = [
      { name: 'chrome_cdp', status: 'pass', detail: 'OK' },
    ];

    const result = buildDoctorResult(checks);

    expect(result.checks).toBe(checks);
    expect(result.summary).toEqual({ total: 1, pass: 1, fail: 0, skip: 0 });
  });
});

describe('checkGoogleDrive', () => {
  it('opens the composer plus menu and passes when the Google Drive entry is visible', async () => {
    const interactions: string[] = [];
    const page = {
      keyboard: {
        press: (key: string): Promise<void> => {
          interactions.push(`key:${key}`);
          return Promise.resolve();
        },
      },
      locator: (selector: string) => {
        if (selector === SELECTORS.COMPOSER_PLUS_BUTTON) {
          return {
            count: () => Promise.resolve(1),
            first: () => ({
              click: () => {
                interactions.push('click:plus');
                return Promise.resolve();
              },
            }),
          };
        }
        if (selector === SELECTORS.MENU_ITEM) {
          return {
            first: () => ({
              waitFor: () => Promise.resolve(),
            }),
            filter: ({ hasText }: { hasText: string }) => ({
              count: () => Promise.resolve(
                MENU_LABELS.ADD_FROM_GOOGLE_DRIVE.some((label) => label === hasText) ? 1 : 0,
              ),
            }),
          };
        }
        throw new Error(`Unexpected selector: ${selector}`);
      },
    };

    const result = await checkGoogleDrive(page as unknown as Parameters<typeof checkGoogleDrive>[0]);

    expect(result).toEqual({
      name: 'gdrive_picker',
      status: 'pass',
      detail: 'Google Drive menu entry found',
    });
    expect(interactions).toEqual(['click:plus', 'key:Escape']);
  });
});

describe('formatTextOutput', () => {
  it('formats each check as a line with status icon', () => {
    const result = buildDoctorResult([
      { name: 'chrome_cdp', status: 'pass', detail: 'Connected' },
      { name: 'cdp_endpoint', status: 'skip', detail: 'not found' },
      { name: 'cloudflare', status: 'fail', detail: 'blocked', action: 'Fix it' },
    ]);

    const lines = formatTextOutput(result);

    // Pass line uses checkmark
    expect(lines[0]).toContain('\u2713');
    expect(lines[0]).toContain('chrome_cdp');
    expect(lines[0]).toContain('Connected');

    // Skip line uses dash (start-of-line match to distinguish from name content)
    expect(lines[1]).toMatch(/^-/);
    expect(lines[1]).toContain('cdp_endpoint');

    // Fail line uses ballot x and includes action
    expect(lines[2]).toContain('\u2717');
    expect(lines[2]).toContain('cloudflare');
    expect(lines[2]).toContain('-> Fix it');

    // Summary line
    const summaryLine = lines[lines.length - 1];
    expect(summaryLine).toContain('Total: 3');
    expect(summaryLine).toContain('Pass: 1');
    expect(summaryLine).toContain('Fail: 1');
    expect(summaryLine).toContain('Skip: 1');
  });

  it('uses cdp_endpoint as the check name (not config_file)', () => {
    // Regression test: Issue #80 — doctor previously used 'config_file' check
    // name for a config.json that did not exist. The check now uses
    // 'cdp_endpoint' and looks for cdp-endpoint.json.
    const checks: DoctorCheck[] = [
      { name: 'cdp_endpoint', status: 'skip', detail: 'not found (optional)' },
    ];
    const result = buildDoctorResult(checks);
    const lines = formatTextOutput(result);

    expect(lines[0]).toContain('cdp_endpoint');
    expect(lines[0]).not.toContain('config_file');
  });

  it('includes empty line before summary', () => {
    const result = buildDoctorResult([
      { name: 'test', status: 'pass' },
    ]);
    const lines = formatTextOutput(result);

    // Second-to-last line should be empty
    expect(lines[lines.length - 2]).toBe('');
  });

  it('formats all status icons correctly', () => {
    const statuses: CheckStatus[] = ['pass', 'fail', 'skip'];
    const checks: DoctorCheck[] = statuses.map((status) => ({
      name: `check_${status}`,
      status,
    }));
    const result = buildDoctorResult(checks);
    const lines = formatTextOutput(result);

    expect(lines[0]).toMatch(/^\u2713/); // pass = checkmark
    expect(lines[1]).toMatch(/^\u2717/); // fail = ballot x
    expect(lines[2]).toMatch(/^-/);      // skip = dash
  });
});
