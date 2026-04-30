import { describe, expect, it } from 'vitest';

import {
  type BaselineComparison,
  type DomSnapshot,
  type ReportResult,
  type SelectorResult,
  buildIssueBody,
  categorizeSelector,
  compareWithBaseline,
  determineBroken,
  formatReportText,
  validateAllSelectors,
  waitForReportReady,
} from '../src/core/report.js';

// ── categorizeSelector ────────────────────────────────────

describe('categorizeSelector', () => {
  it('categorizes homepage selectors', () => {
    expect(categorizeSelector('PROMPT_INPUT')).toBe('homepage');
    expect(categorizeSelector('MODEL_SELECTOR_BUTTON')).toBe('homepage');
    expect(categorizeSelector('FILE_INPUT_GENERIC')).toBe('homepage');
  });

  it('categorizes auth selectors', () => {
    expect(categorizeSelector('CF_TURNSTILE_IFRAME')).toBe('auth');
    expect(categorizeSelector('LOGIN_BUTTON')).toBe('auth');
  });

  it('categorizes contextual selectors', () => {
    expect(categorizeSelector('ASSISTANT_MESSAGE')).toBe('contextual');
    expect(categorizeSelector('COPY_BUTTON')).toBe('contextual');
    expect(categorizeSelector('STOP_BUTTON')).toBe('contextual');
  });

  it('defaults unknown names to contextual', () => {
    expect(categorizeSelector('NONEXISTENT_SELECTOR')).toBe('contextual');
  });
});

describe('validateAllSelectors', () => {
  it('counts Deep Research selectors inside the matching iframe', async () => {
    const page = {
      locator: () => ({
        count: () => Promise.resolve(0),
      }),
      frames: () => [
        {
          url: () => 'https://chatgpt.com/app/deep_research/session',
          locator: (selector: string) => ({
            count: () => Promise.resolve(selector === '.deep-research-app' ? 1 : 0),
          }),
        },
      ],
    };

    const results = await validateAllSelectors(page as unknown as Parameters<typeof validateAllSelectors>[0], true);
    const deepResearchApp = results.find((result) => result.name === 'DEEP_RESEARCH_APP');

    expect(deepResearchApp).toEqual(expect.objectContaining({
      count: 1,
    }));
  });

  it('does not count Deep Research selector matches from the outer page', async () => {
    const page = {
      locator: (selector: string) => ({
        count: () => Promise.resolve(selector === 'main' ? 1 : 0),
      }),
      frames: () => [
        {
          url: () => 'https://chatgpt.com/app/deep_research/session',
          locator: () => ({
            count: () => Promise.resolve(0),
          }),
        },
      ],
    };

    const results = await validateAllSelectors(page as unknown as Parameters<typeof validateAllSelectors>[0], true);
    const deepResearchReportRoot = results.find((result) => result.name === 'DEEP_RESEARCH_REPORT_ROOT');

    expect(deepResearchReportRoot).toEqual(expect.objectContaining({
      count: 0,
    }));
  });
});

describe('waitForReportReady', () => {
  it('waits for the prompt composer before report selector validation', async () => {
    const calls: string[] = [];
    const page = {
      locator: (selector: string) => {
        calls.push(selector);
        return {
          waitFor: ({ state, timeout }: { state: string; timeout: number }) => {
            calls.push(`${state}:${String(timeout)}`);
            return Promise.resolve();
          },
        };
      },
    };

    await waitForReportReady(page as unknown as Parameters<typeof waitForReportReady>[0], true, 1234);

    expect(calls).toEqual(['#prompt-textarea', 'visible:1234']);
  });
});

// ── compareWithBaseline ───────────────────────────────────

function makeBaseline(selectors: SelectorResult[]): DomSnapshot {
  return {
    version: 1,
    timestamp: '2026-03-18T00:00:00Z',
    selectors,
    structure: [],
    environment: {
      chrome: 'Chrome 131',
      url: 'https://chatgpt.com',
      timestamp: '2026-03-18T00:00:00Z',
    },
  };
}

describe('compareWithBaseline', () => {
  it('detects new misses (was hit, now miss)', () => {
    const baseline = makeBaseline([
      { name: 'A', selector: '#a', count: 1, category: 'homepage' },
    ]);
    const current: SelectorResult[] = [
      { name: 'A', selector: '#a', count: 0, category: 'homepage' },
    ];
    const result = compareWithBaseline(current, baseline);
    expect(result.newMisses).toEqual(['A']);
    expect(result.newHits).toEqual([]);
    expect(result.unchanged).toBe(0);
  });

  it('detects new hits (was miss, now hit)', () => {
    const baseline = makeBaseline([
      { name: 'A', selector: '#a', count: 0, category: 'contextual' },
    ]);
    const current: SelectorResult[] = [
      { name: 'A', selector: '#a', count: 1, category: 'contextual' },
    ];
    const result = compareWithBaseline(current, baseline);
    expect(result.newMisses).toEqual([]);
    expect(result.newHits).toEqual(['A']);
  });

  it('counts unchanged selectors', () => {
    const baseline = makeBaseline([
      { name: 'A', selector: '#a', count: 1, category: 'homepage' },
      { name: 'B', selector: '#b', count: 0, category: 'contextual' },
    ]);
    const current: SelectorResult[] = [
      { name: 'A', selector: '#a', count: 1, category: 'homepage' },
      { name: 'B', selector: '#b', count: 0, category: 'contextual' },
    ];
    const result = compareWithBaseline(current, baseline);
    expect(result.unchanged).toBe(2);
    expect(result.newMisses).toEqual([]);
    expect(result.newHits).toEqual([]);
  });

  it('ignores new selectors not in baseline', () => {
    const baseline = makeBaseline([
      { name: 'A', selector: '#a', count: 1, category: 'homepage' },
    ]);
    const current: SelectorResult[] = [
      { name: 'A', selector: '#a', count: 1, category: 'homepage' },
      { name: 'NEW', selector: '#new', count: 0, category: 'contextual' },
    ];
    const result = compareWithBaseline(current, baseline);
    expect(result.unchanged).toBe(1);
    expect(result.newMisses).toEqual([]);
    expect(result.newHits).toEqual([]);
  });

  it('handles multiple changes at once', () => {
    const baseline = makeBaseline([
      { name: 'A', selector: '#a', count: 1, category: 'homepage' },
      { name: 'B', selector: '#b', count: 0, category: 'contextual' },
      { name: 'C', selector: '#c', count: 3, category: 'contextual' },
    ]);
    const current: SelectorResult[] = [
      { name: 'A', selector: '#a', count: 0, category: 'homepage' },
      { name: 'B', selector: '#b', count: 2, category: 'contextual' },
      { name: 'C', selector: '#c', count: 3, category: 'contextual' },
    ];
    const result = compareWithBaseline(current, baseline);
    expect(result.newMisses).toEqual(['A']);
    expect(result.newHits).toEqual(['B']);
    expect(result.unchanged).toBe(1);
  });
});

// ── determineBroken ───────────────────────────────────────

describe('determineBroken', () => {
  it('marks homepage selectors with 0 count as broken', () => {
    const selectors: SelectorResult[] = [
      { name: 'PROMPT_INPUT', selector: '#prompt-textarea', count: 0, category: 'homepage' },
      { name: 'MODEL_SELECTOR_BUTTON', selector: '[data-testid="msdb"]', count: 1, category: 'homepage' },
    ];
    const broken = determineBroken(selectors, null);
    expect(broken).toHaveLength(1);
    expect(broken[0].name).toBe('PROMPT_INPUT');
  });

  it('marks baseline misses as broken', () => {
    const selectors: SelectorResult[] = [
      { name: 'COPY_BUTTON', selector: '[data-testid="copy"]', count: 0, category: 'contextual' },
    ];
    const baseline: BaselineComparison = {
      newMisses: ['COPY_BUTTON'],
      newHits: [],
      unchanged: 0,
    };
    const broken = determineBroken(selectors, baseline);
    expect(broken).toHaveLength(1);
    expect(broken[0].name).toBe('COPY_BUTTON');
  });

  it('does not mark Deep Research contextual selectors as broken on non-Deep-Research reports', () => {
    const selectors: SelectorResult[] = [
      { name: 'DEEP_RESEARCH_REPORT_ROOT', selector: 'main', count: 0, category: 'contextual' },
    ];
    const baseline: BaselineComparison = {
      newMisses: ['DEEP_RESEARCH_REPORT_ROOT'],
      newHits: [],
      unchanged: 0,
    };
    const broken = determineBroken(selectors, baseline);
    expect(broken).toHaveLength(0);
  });

  it('does not mark contextual selectors as broken without baseline', () => {
    const selectors: SelectorResult[] = [
      { name: 'COPY_BUTTON', selector: '[data-testid="copy"]', count: 0, category: 'contextual' },
    ];
    const broken = determineBroken(selectors, null);
    expect(broken).toHaveLength(0);
  });

  it('does not mark hit selectors as broken regardless of baseline', () => {
    const selectors: SelectorResult[] = [
      { name: 'PROMPT_INPUT', selector: '#prompt-textarea', count: 1, category: 'homepage' },
    ];
    const baseline: BaselineComparison = {
      newMisses: ['PROMPT_INPUT'],
      newHits: [],
      unchanged: 0,
    };
    const broken = determineBroken(selectors, baseline);
    expect(broken).toHaveLength(0);
  });

  it('does not mark auth selectors as broken', () => {
    const selectors: SelectorResult[] = [
      { name: 'LOGIN_BUTTON', selector: '[data-testid="login-button"]', count: 0, category: 'auth' },
    ];
    const broken = determineBroken(selectors, null);
    expect(broken).toHaveLength(0);
  });
});

// ── formatReportText ──────────────────────────────────────

const ENV = {
  chrome: 'Chrome 131',
  url: 'https://chatgpt.com',
  timestamp: '2026-03-18T00:00:00Z',
};

describe('formatReportText', () => {
  it('includes environment info', () => {
    const result: ReportResult = {
      selectors: [],
      broken: [],
      structure: [],
      baseline: null,
      environment: ENV,
    };
    const lines = formatReportText(result);
    expect(lines.some((l) => l.includes('Chrome 131'))).toBe(true);
    expect(lines.some((l) => l.includes('https://chatgpt.com'))).toBe(true);
  });

  it('shows broken selectors section when present', () => {
    const result: ReportResult = {
      selectors: [
        { name: 'PROMPT_INPUT', selector: '#prompt-textarea', count: 0, category: 'homepage' },
      ],
      broken: [
        { name: 'PROMPT_INPUT', selector: '#prompt-textarea', count: 0, category: 'homepage' },
      ],
      structure: [],
      baseline: null,
      environment: ENV,
    };
    const lines = formatReportText(result);
    expect(lines.some((l) => l.includes('BROKEN SELECTORS'))).toBe(true);
    expect(lines.some((l) => l.includes('PROMPT_INPUT'))).toBe(true);
  });

  it('omits broken section when none are broken', () => {
    const result: ReportResult = {
      selectors: [
        { name: 'PROMPT_INPUT', selector: '#prompt-textarea', count: 1, category: 'homepage' },
      ],
      broken: [],
      structure: [],
      baseline: null,
      environment: ENV,
    };
    const lines = formatReportText(result);
    expect(lines.some((l) => l.includes('BROKEN SELECTORS'))).toBe(false);
  });

  it('shows summary line with correct counts', () => {
    const result: ReportResult = {
      selectors: [
        { name: 'A', selector: '#a', count: 1, category: 'homepage' },
        { name: 'B', selector: '#b', count: 0, category: 'contextual' },
        { name: 'C', selector: '#c', count: 3, category: 'contextual' },
      ],
      broken: [],
      structure: [],
      baseline: null,
      environment: ENV,
    };
    const lines = formatReportText(result);
    const summary = lines.find((l) => l.includes('Total:'));
    expect(summary).toContain('Total: 3');
    expect(summary).toContain('Hit: 2');
    expect(summary).toContain('Miss: 1');
  });

  it('shows baseline comparison when available', () => {
    const result: ReportResult = {
      selectors: [],
      broken: [],
      structure: [],
      baseline: { newMisses: ['X'], newHits: ['Y'], unchanged: 5 },
      environment: ENV,
    };
    const lines = formatReportText(result);
    expect(lines.some((l) => l.includes('Baseline Comparison'))).toBe(true);
    expect(lines.some((l) => l.includes('Unchanged: 5'))).toBe(true);
  });
});

// ── buildIssueBody ────────────────────────────────────────

describe('buildIssueBody', () => {
  it('includes broken selectors table', () => {
    const result: ReportResult = {
      selectors: [],
      broken: [
        { name: 'FILE_INPUT_GENERIC', selector: '#upload-files', count: 0, category: 'homepage' },
      ],
      structure: [],
      baseline: null,
      environment: ENV,
    };
    const body = buildIssueBody(result);
    expect(body).toContain('FILE_INPUT_GENERIC');
    expect(body).toContain('#upload-files');
    expect(body).toContain('## Broken Selectors');
  });

  it('includes DOM elements with data-testid', () => {
    const result: ReportResult = {
      selectors: [],
      broken: [],
      structure: [
        { tag: 'button', testId: 'send-button', path: 'main > form > button' },
      ],
      baseline: null,
      environment: ENV,
    };
    const body = buildIssueBody(result);
    expect(body).toContain('send-button');
    expect(body).toContain('data-testid');
  });

  it('includes baseline changes when present', () => {
    const result: ReportResult = {
      selectors: [
        { name: 'X', selector: '#x', count: 0, category: 'contextual' },
      ],
      broken: [],
      structure: [],
      baseline: { newMisses: ['X'], newHits: [], unchanged: 0 },
      environment: ENV,
    };
    const body = buildIssueBody(result);
    expect(body).toContain('## Baseline Changes');
    expect(body).toContain('`X`');
  });

  it('includes environment info', () => {
    const result: ReportResult = {
      selectors: [],
      broken: [],
      structure: [],
      baseline: null,
      environment: ENV,
    };
    const body = buildIssueBody(result);
    expect(body).toContain('Chrome 131');
    expect(body).toContain('## Environment');
  });
});
