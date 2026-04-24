/**
 * Report — selector validation, DOM structure capture, baseline comparison,
 * and GitHub issue creation for detecting ChatGPT UI changes.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from 'playwright-core';

import { SELECTORS, type SelectorKey } from '../constants/selectors.js';

import { CAVENDISH_DIR } from './browser-manager.js';
import { errorMessage, progress } from './output-handler.js';

// ── Constants ─────────────────────────────────────────────

export const DOM_SNAPSHOT_FILE = join(CAVENDISH_DIR, 'dom-snapshot.json');
export const SNAPSHOT_VERSION = 1;
const FILE_MODE = 0o600;
const MAX_DOM_ELEMENTS = 300;

// ── Types ─────────────────────────────────────────────────

export type SelectorCategory = 'homepage' | 'contextual' | 'auth';

export interface SelectorResult {
  name: string;
  selector: string;
  count: number;
  category: SelectorCategory;
}

export interface DomElement {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
  ariaLabel?: string;
  type?: string;
  path: string;
}

export interface EnvironmentInfo {
  chrome: string;
  url: string;
  timestamp: string;
}

export interface BaselineComparison {
  newMisses: string[];
  newHits: string[];
  unchanged: number;
}

export interface ReportResult {
  selectors: SelectorResult[];
  broken: SelectorResult[];
  structure: DomElement[];
  baseline: BaselineComparison | null;
  environment: EnvironmentInfo;
}

export interface DomSnapshot {
  version: number;
  timestamp: string;
  selectors: SelectorResult[];
  structure: DomElement[];
  environment: EnvironmentInfo;
}

// ── Selector categories ───────────────────────────────────

function selectorSet(keys: SelectorKey[]): ReadonlySet<string> {
  return new Set(keys);
}

/** Selectors expected to match on a fresh chatgpt.com homepage. */
const HOMEPAGE_SELECTORS = selectorSet([
  'PROMPT_INPUT',
  'MODEL_SELECTOR_BUTTON',
  'SIDEBAR_HISTORY',
  'NEW_CHAT_LINK',
  'COMPOSER_PLUS_BUTTON',
  'COMPOSER_FOOTER_ACTIONS',
  'FILE_INPUT_GENERIC',
]);

/** Auth/CF selectors — presence indicates NOT logged in. */
const AUTH_SELECTORS = selectorSet([
  'CF_TURNSTILE_IFRAME',
  'CF_CHALLENGE_FORM',
  'LOGIN_BUTTON',
  'CONTINUE_WITH_GOOGLE',
]);

/** Non-CSS selectors that cannot be tested via locator. */
const SKIP_SELECTORS = selectorSet([
  'DEEP_RESEARCH_FRAME_URL',
  'REPORT_DOM_QUERY',
]);

function isDeepResearchSelector(key: SelectorKey): boolean {
  return key.startsWith('DEEP_RESEARCH_') && key !== 'DEEP_RESEARCH_FRAME_URL';
}

async function countSelector(page: Page, key: SelectorKey, selector: string): Promise<number> {
  const pageCount = await page.locator(selector).count();
  if (!isDeepResearchSelector(key)) {
    return pageCount;
  }
  const frameCounts = await Promise.all(
    page.frames()
      .filter((frame) => frame.url().includes(SELECTORS.DEEP_RESEARCH_FRAME_URL))
      .map((frame) => frame.locator(selector).count()),
  );
  return frameCounts.reduce((sum, count) => sum + count, pageCount);
}

export function categorizeSelector(name: string): SelectorCategory {
  if (HOMEPAGE_SELECTORS.has(name)) {return 'homepage';}
  if (AUTH_SELECTORS.has(name)) {return 'auth';}
  return 'contextual';
}

// ── Selector validation ───────────────────────────────────

export async function validateAllSelectors(
  page: Page,
  quiet: boolean,
): Promise<SelectorResult[]> {
  progress('Validating selectors against live DOM...', quiet);

  const keys = (Object.keys(SELECTORS) as SelectorKey[]).filter(
    (k) => !SKIP_SELECTORS.has(k),
  );

  return Promise.all(
    keys.map(async (key): Promise<SelectorResult> => {
      const selector = SELECTORS[key];
      try {
        const count = await countSelector(page, key, selector);
        return { name: key, selector, count, category: categorizeSelector(key) };
      } catch (error: unknown) {
        progress('Warning: selector ' + key + ' failed: ' + errorMessage(error), quiet);
        return { name: key, selector, count: 0, category: categorizeSelector(key) };
      }
    }),
  );
}

// ── DOM structure capture ─────────────────────────────────

export async function captureDomStructure(
  page: Page,
  quiet: boolean,
): Promise<DomElement[]> {
  progress('Capturing DOM structure...', quiet);

  interface RawElement {
    tag: string;
    id?: string;
    testId?: string;
    role?: string;
    ariaLabel?: string;
    type?: string;
    path: string;
  }

  const domQuery = SELECTORS.REPORT_DOM_QUERY;

  return page.evaluate(({ maxElements, query }): RawElement[] => {
    function getPath(el: Element): string {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.body && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        if (current.id) {part += '#' + current.id;}
        const tid = current.getAttribute('data-testid');
        if (tid) {part += '[data-testid="' + tid + '"]';}
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    const nodeList = document.querySelectorAll(query);

    return Array.from(nodeList)
      .slice(0, maxElements)
      .map((el): RawElement => {
        const item: RawElement = { tag: el.tagName.toLowerCase(), path: getPath(el) };
        if (el.id) {item.id = el.id;}
        const tid = el.getAttribute('data-testid');
        if (tid) {item.testId = tid;}
        const role = el.getAttribute('role');
        if (role) {item.role = role;}
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {item.ariaLabel = ariaLabel;}
        const type = el.getAttribute('type');
        if (type) {item.type = type;}
        return item;
      });
  }, { maxElements: MAX_DOM_ELEMENTS, query: domQuery });
}

// ── Environment info ──────────────────────────────────────

export async function collectEnvironment(page: Page): Promise<EnvironmentInfo> {
  const userAgent: string = await page.evaluate((): string => navigator.userAgent);
  const chromeMatch = /Chrome\/([\d.]+)/.exec(userAgent);
  return {
    chrome: chromeMatch ? 'Chrome ' + chromeMatch[1] : userAgent,
    url: page.url(),
    timestamp: new Date().toISOString(),
  };
}

// ── Baseline management ───────────────────────────────────

export function loadBaseline(): DomSnapshot | null {
  if (!existsSync(DOM_SNAPSHOT_FILE)) {return null;}
  try {
    const raw = readFileSync(DOM_SNAPSHOT_FILE, 'utf8');
    const data = JSON.parse(raw) as DomSnapshot;
    if (data.version !== SNAPSHOT_VERSION || !Array.isArray(data.selectors)) {return null;}
    return data;
  } catch (error: unknown) {
    progress('Warning: failed to load baseline: ' + errorMessage(error), false);
    return null;
  }
}

export function saveBaseline(snapshot: DomSnapshot): void {
  writeFileSync(DOM_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), { mode: FILE_MODE });
  chmodSync(DOM_SNAPSHOT_FILE, FILE_MODE);
}

// ── Baseline comparison ───────────────────────────────────

export function compareWithBaseline(
  current: SelectorResult[],
  baseline: DomSnapshot,
): BaselineComparison {
  const baselineMap = new Map<string, number>();
  for (const s of baseline.selectors) {
    baselineMap.set(s.name, s.count);
  }

  const newMisses: string[] = [];
  const newHits: string[] = [];
  let unchanged = 0;

  for (const s of current) {
    const baseCount = baselineMap.get(s.name);
    if (baseCount === undefined) {continue;}

    const wasHit = baseCount > 0;
    const nowHit = s.count > 0;

    if (wasHit && !nowHit) {
      newMisses.push(s.name);
    } else if (!wasHit && nowHit) {
      newHits.push(s.name);
    } else {
      unchanged++;
    }
  }

  return { newMisses, newHits, unchanged };
}

// ── Broken selector detection ─────────────────────────────

/**
 * Determine which selectors are broken.
 * A homepage selector with 0 matches is always broken.
 * If a baseline exists, any selector that was hit but now misses is also broken.
 */
export function determineBroken(
  selectors: SelectorResult[],
  baseline: BaselineComparison | null,
): SelectorResult[] {
  const baselineMisses = new Set(baseline?.newMisses ?? []);
  return selectors.filter((s) => {
    if (s.count > 0) {return false;}
    return s.category === 'homepage' || baselineMisses.has(s.name);
  });
}

// ── Text formatting ───────────────────────────────────────

/** Display order for selector categories in text output. */
const CATEGORY_ORDER: readonly SelectorCategory[] = ['homepage', 'contextual', 'auth'];

const HIT_ICON = '\u2713';
const MISS_ICON = '\u2717';
const SKIP_ICON = '-';

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function selectorIcon(s: SelectorResult): string {
  if (s.count > 0) { return HIT_ICON; }
  if (s.category === 'homepage') { return MISS_ICON; }
  return SKIP_ICON;
}

function formatSelectorsByCategory(selectors: SelectorResult[]): string[] {
  const lines: string[] = [];
  const byCategory = new Map<SelectorCategory, SelectorResult[]>();
  for (const s of selectors) {
    let list = byCategory.get(s.category);
    if (!list) {
      list = [];
      byCategory.set(s.category, list);
    }
    list.push(s);
  }

  const labels: Record<SelectorCategory, string> = {
    homepage: 'Homepage (expected on fresh page)',
    contextual: 'Contextual (may be absent)',
    auth: 'Auth/CF (presence = not logged in)',
  };

  for (const cat of CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) { continue; }

    lines.push(labels[cat] + ':');
    for (const s of items) {
      const name = s.name.padEnd(36);
      const sel = truncate(s.selector, 45).padEnd(45);
      lines.push('  ' + selectorIcon(s) + ' ' + name + ' ' + sel + ' (' + String(s.count) + ')');
    }
    lines.push('');
  }

  return lines;
}

function formatBaselineSection(baseline: BaselineComparison): string[] {
  const lines: string[] = [];
  lines.push('Baseline Comparison:');
  if (baseline.newMisses.length > 0) {
    lines.push('  New misses (was hit, now miss):');
    for (const name of baseline.newMisses) {
      lines.push('    ' + MISS_ICON + ' ' + name);
    }
  }
  if (baseline.newHits.length > 0) {
    lines.push('  New hits (was miss, now hit):');
    for (const name of baseline.newHits) {
      lines.push('    ' + HIT_ICON + ' ' + name);
    }
  }
  lines.push('  Unchanged: ' + String(baseline.unchanged));
  lines.push('');
  return lines;
}

export function formatReportText(result: ReportResult): string[] {
  const lines: string[] = [];

  lines.push('Environment:');
  lines.push('  Chrome: ' + result.environment.chrome);
  lines.push('  URL:    ' + result.environment.url);
  lines.push('  Time:   ' + result.environment.timestamp);
  lines.push('');

  lines.push(...formatSelectorsByCategory(result.selectors));

  if (result.broken.length > 0) {
    lines.push('BROKEN SELECTORS:');
    for (const s of result.broken) {
      lines.push('  ' + MISS_ICON + ' ' + s.name + '  ' + s.selector);
    }
    lines.push('');
  }

  if (result.baseline) {
    lines.push(...formatBaselineSection(result.baseline));
  }

  const hit = result.selectors.filter((s) => s.count > 0).length;
  const miss = result.selectors.length - hit;
  lines.push(
    'Total: ' + String(result.selectors.length) + '  '
    + 'Hit: ' + String(hit) + '  '
    + 'Miss: ' + String(miss) + '  '
    + 'Broken: ' + String(result.broken.length),
  );

  return lines;
}

// ── GitHub issue creation ─────────────────────────────────

/**
 * Resolve the absolute path of the `gh` CLI binary.
 * Returns null if not found on PATH.
 */
function resolveGhPath(): string | null {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = execFileSync(cmd, ['gh'], { // NOSONAR — cmd is a fixed string, not user input
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const firstLine = result.split('\n')[0]?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

export function buildIssueBody(result: ReportResult): string {
  const lines: string[] = [];

  lines.push('## Broken Selectors');
  lines.push('');
  lines.push('| Name | Selector | Category | Count |');
  lines.push('|------|----------|----------|-------|');
  for (const s of result.broken) {
    lines.push(
      '| `' + s.name + '` | `' + s.selector + '` | ' + s.category + ' | ' + String(s.count) + ' |',
    );
  }
  lines.push('');

  if (result.baseline && result.baseline.newMisses.length > 0) {
    const selectorMap = new Map(result.selectors.map((s) => [s.name, s]));
    lines.push('## Baseline Changes');
    lines.push('');
    lines.push('These selectors matched in the baseline but no longer match:');
    for (const name of result.baseline.newMisses) {
      const sel = selectorMap.get(name);
      lines.push('- `' + name + '`: `' + (sel?.selector ?? 'unknown') + '`');
    }
    lines.push('');
  }

  const testIdElements = result.structure.filter((e) => e.testId);
  if (testIdElements.length > 0) {
    lines.push('<details>');
    lines.push(
      '<summary>DOM Elements with data-testid (' + String(testIdElements.length) + ' found)</summary>',
    );
    lines.push('');
    lines.push('| Path | data-testid |');
    lines.push('|------|-------------|');
    for (const el of testIdElements) {
      lines.push('| `' + el.path + '` | `' + (el.testId ?? '') + '` |');
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('## Environment');
  lines.push('');
  lines.push('- Chrome: ' + result.environment.chrome);
  lines.push('- URL: ' + result.environment.url);
  lines.push('- OS: ' + process.platform);
  lines.push('- Time: ' + result.environment.timestamp);
  lines.push('');
  lines.push('---');
  lines.push('*Auto-generated by `cavendish report --issue`*');

  return lines.join('\n');
}

export function createGitHubIssue(result: ReportResult, quiet: boolean): boolean {
  const ghPath = resolveGhPath();
  if (!ghPath) {
    progress(
      'Warning: gh CLI not found — cannot create GitHub issue. Install: https://cli.github.com/',
      quiet,
    );
    return false;
  }

  const brokenNames = result.broken.map((s) => s.name).join(', ');
  const title =
    '[selector-drift] ' + String(result.broken.length) + ' selector(s) broken: ' + brokenNames;
  const body = buildIssueBody(result);

  try {
    const output = execFileSync(ghPath, [
      'issue', 'create',
      '--title', title.length > 200 ? title.slice(0, 197) + '...' : title,
      '--body', body,
    ], { encoding: 'utf8', timeout: 30_000 });

    progress('GitHub issue created: ' + output.trim(), quiet);
    return true;
  } catch (error: unknown) {
    const stderr = (error as { stderr?: string }).stderr;
    const detail = stderr ? stderr.trim() : errorMessage(error);
    progress('Warning: Failed to create GitHub issue: ' + detail, quiet);
    return false;
  }
}
