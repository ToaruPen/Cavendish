import { describe, expect, it } from 'vitest';

import { type ReportPollState, evaluateReportPoll } from '../src/core/driver/deep-research.js';

describe('evaluateReportPoll', () => {
  function makeState(overrides: Partial<ReportPollState> = {}): ReportPollState {
    return { exportObservedAbsent: false, ...overrides };
  }

  it('returns null when stop button is visible', () => {
    const state = makeState();
    const result = evaluateReportPoll('some text', true, false, false, '', state);
    expect(result).toBeNull();
  });

  it('returns null when text is empty', () => {
    const state = makeState();
    const result = evaluateReportPoll('', false, false, false, 'pre', state);
    expect(result).toBeNull();
  });

  it('returns text immediately when seenStopButton and text differs from preActionText', () => {
    const state = makeState();
    const result = evaluateReportPoll('final report', false, false, true, 'pre-action', state);
    expect(result).toBe('final report');
  });

  it('returns null when seenStopButton but text equals preActionText', () => {
    const state = makeState();
    const result = evaluateReportPoll('pre-action', false, false, true, 'pre-action', state);
    expect(result).toBeNull();
  });

  it('does not return stale preActionText via stability check when seenStopButton is true', () => {
    const state = makeState();
    // Call multiple times with text === preActionText and seenStopButton=true.
    // Every call must return null — the algorithm must never promote stale text.
    for (let i = 0; i < 5; i++) {
      const result = evaluateReportPoll('pre-action', false, false, true, 'pre-action', state);
      expect(result).toBeNull();
    }
  });

  it('returns null when no transition and text equals preActionText (no stop button)', () => {
    const state = makeState();
    const result = evaluateReportPoll('pre-action', false, false, false, 'pre-action', state);
    expect(result).toBeNull();
  });

  it('returns text immediately when no stale export was present at action time', () => {
    // pollForDeepResearchReport seeds exportObservedAbsent from the caller, so
    // initial calls and follow-ups whose previous report had no export visible
    // start with the flag true.  Research that finishes faster than the 60s
    // stop-detect window must still complete on the first poll where
    // hasExport=true.
    const state = makeState({ exportObservedAbsent: true });
    const result = evaluateReportPoll('final report', false, true, false, '', state);
    expect(result).toBe('final report');
  });

  it('completes follow-up via export only after observed disappearance', () => {
    // Follow-up/refresh: the previous report's export button may still be
    // visible at start.  exportObservedAbsent is false initially; we only
    // trust hasExport=true after observing hasExport=false at least once.
    const state = makeState();
    expect(evaluateReportPoll('plan text', false, false, false, 'old report', state)).toBeNull();
    expect(state.exportObservedAbsent).toBe(true);
    const result = evaluateReportPoll('new report', false, true, false, 'old report', state);
    expect(result).toBe('new report');
  });

  it('completes a refresh with identical regenerated text via export transition', () => {
    // Refresh / follow-up that regenerates identical report text must still
    // complete: the observed export disappearance + reappearance proves a
    // fresh render cycle even when the text equals preActionText.
    const state = makeState();
    expect(evaluateReportPoll('plan text', false, false, false, 'old report', state)).toBeNull();
    expect(state.exportObservedAbsent).toBe(true);
    const result = evaluateReportPoll('old report', false, true, false, 'old report', state);
    expect(result).toBe('old report');
  });

  it('does NOT return text on stale export visible from a previous report', () => {
    // Regression for the follow-up/refresh false-positive: the previous
    // report's export button is still visible at the start of the new run.
    // Without observing it disappear, we cannot trust the export signal.
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      const result = evaluateReportPoll('new plan text', false, true, false, 'old report', state);
      expect(result).toBeNull();
    }
    expect(state.exportObservedAbsent).toBe(false);
  });

  it('records exportObservedAbsent the first time hasExport is observed false', () => {
    const state = makeState();
    expect(state.exportObservedAbsent).toBe(false);
    evaluateReportPoll('text', false, false, false, 'pre', state);
    expect(state.exportObservedAbsent).toBe(true);
  });

  it('does NOT return text via stability alone without seenStopButton or export visibility', () => {
    // Regression for the bug where the previous implementation auto-
    // completed after STABLE_THRESHOLD identical reads.  On a first DR
    // call preActionText is empty, so plan text would falsely satisfy
    // the stability check and be returned as the final report.
    const state = makeState();
    for (let i = 0; i < 10; i++) {
      const result = evaluateReportPoll('plan...', false, false, false, '', state);
      expect(result).toBeNull();
    }
  });

  it('treats hasStop as authoritative — never returns text even with hasExport', () => {
    // If the stop button is currently visible, research is still in
    // progress regardless of any other signal.
    const state = makeState({ exportObservedAbsent: true });
    const result = evaluateReportPoll('text', true, true, true, 'pre', state);
    expect(result).toBeNull();
  });
});
