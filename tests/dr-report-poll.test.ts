import { describe, expect, it } from 'vitest';

import { type ReportPollState, evaluateReportPoll } from '../src/core/driver/deep-research.js';

describe('evaluateReportPoll', () => {
  function makeState(overrides: Partial<ReportPollState> = {}): ReportPollState {
    return { stableCount: 0, previousText: '', sawTransition: false, ...overrides };
  }

  it('returns null when stop button is visible', () => {
    const state = makeState();
    const result = evaluateReportPoll('some text', true, false, '', state);
    expect(result).toBeNull();
    expect(state.sawTransition).toBe(true);
    expect(state.stableCount).toBe(0);
  });

  it('returns null when text is empty', () => {
    const state = makeState();
    const result = evaluateReportPoll('', false, false, 'pre', state);
    expect(result).toBeNull();
    expect(state.sawTransition).toBe(true);
    expect(state.previousText).toBe('');
  });

  it('returns text immediately when seenStopButton and text differs from preActionText', () => {
    const state = makeState({ sawTransition: true });
    const result = evaluateReportPoll('final report', false, true, 'pre-action', state);
    expect(result).toBe('final report');
  });

  it('returns null when seenStopButton but text equals preActionText and resets stableCount', () => {
    const state = makeState({ sawTransition: true, stableCount: 2 });
    const result = evaluateReportPoll('pre-action', false, true, 'pre-action', state);
    expect(result).toBeNull();
    expect(state.stableCount).toBe(0);
  });

  it('does not return stale preActionText via stability check when seenStopButton is true', () => {
    const state = makeState({
      sawTransition: true,
      previousText: 'pre-action',
      stableCount: 0,
    });
    // Call multiple times with text === preActionText and seenStopButton=true.
    // Every call must return null — the stability check must never promote stale text.
    for (let i = 0; i < 5; i++) {
      const result = evaluateReportPoll('pre-action', false, true, 'pre-action', state);
      expect(result).toBeNull();
      expect(state.stableCount).toBe(0);
    }
  });

  it('returns null when no transition and text equals preActionText (no stop button)', () => {
    const state = makeState({ sawTransition: false });
    const result = evaluateReportPoll('pre-action', false, false, 'pre-action', state);
    expect(result).toBeNull();
    expect(state.stableCount).toBe(0);
  });

  it('increments stableCount on consecutive identical reads', () => {
    const state = makeState({ sawTransition: true, previousText: 'report' });
    const result = evaluateReportPoll('report', false, false, 'pre', state);
    expect(result).toBeNull();
    expect(state.stableCount).toBe(1);
  });

  it('returns text after STABLE_THRESHOLD (3) consecutive identical reads', () => {
    const state = makeState({ sawTransition: true, previousText: 'report', stableCount: 1 });

    // 2nd consecutive match
    const r1 = evaluateReportPoll('report', false, false, 'pre', state);
    expect(r1).toBeNull();
    expect(state.stableCount).toBe(2);

    // 3rd consecutive match → threshold reached
    const r2 = evaluateReportPoll('report', false, false, 'pre', state);
    expect(r2).toBe('report');
  });

  it('resets stableCount when text changes', () => {
    const state = makeState({ sawTransition: true, previousText: 'old', stableCount: 2 });
    const result = evaluateReportPoll('new', false, false, 'pre', state);
    expect(result).toBeNull();
    expect(state.stableCount).toBe(0);
    expect(state.previousText).toBe('new');
  });

  it('marks sawTransition when text differs from preActionText', () => {
    const state = makeState({ sawTransition: false });
    evaluateReportPoll('new text', false, false, 'pre-action', state);
    expect(state.sawTransition).toBe(true);
  });
});
