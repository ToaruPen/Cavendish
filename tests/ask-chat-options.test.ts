import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonRaw, outputList } from '../src/core/output-handler.js';

describe('jsonRaw()', () => {
  const writeCalls: string[] = [];

  beforeEach(() => {
    writeCalls.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writeCalls.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes an array as JSON to stdout', () => {
    const data = [{ id: 'abc', title: 'Test Chat' }];
    jsonRaw(data);

    expect(writeCalls).toHaveLength(1);
    const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
    expect(parsed).toEqual(data);
  });

  it('writes an empty array', () => {
    jsonRaw([]);

    expect(writeCalls).toEqual(['[]\n']);
  });

  it('writes a plain object', () => {
    jsonRaw({ id: 'p1', name: 'My Project' });

    const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
    expect(parsed).toEqual({ id: 'p1', name: 'My Project' });
  });
});

describe('outputList()', () => {
  const writeCalls: string[] = [];

  beforeEach(() => {
    writeCalls.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writeCalls.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs conversations as JSON', () => {
    const items = [{ id: 'c1', title: 'Chat One' }, { id: 'c2', title: 'Chat Two' }];
    outputList(items, 'json');

    expect(writeCalls).toHaveLength(1);
    const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
    expect(parsed).toEqual(items);
  });

  it('outputs conversations as tab-separated text using title', () => {
    outputList([{ id: 'c1', title: 'My Chat' }], 'text');

    expect(writeCalls).toEqual(['c1\tMy Chat\n']);
  });

  it('outputs projects as tab-separated text using name', () => {
    outputList([{ id: 'p1', name: 'My Project' }], 'text');

    expect(writeCalls).toEqual(['p1\tMy Project\n']);
  });

  it('handles empty list', () => {
    outputList([], 'json');

    expect(writeCalls).toEqual(['[]\n']);
  });
});
