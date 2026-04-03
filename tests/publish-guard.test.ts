import { describe, expect, it, vi } from 'vitest';

import {
  buildRegistryVersionUrl,
  checkPublishVersion,
} from '../.github/scripts/check-publish-version.mjs';

type FetchImpl = NonNullable<Parameters<typeof checkPublishVersion>[0]['fetchImpl']>;
type RegistryResponse = Awaited<ReturnType<FetchImpl>>;

function makeRegistryResponse(
  ok: boolean,
  status: number,
  statusText: string,
): RegistryResponse {
  return {
    ok,
    status,
    statusText,
  };
}

describe('buildRegistryVersionUrl', () => {
  it('encodes scoped package names and versions', () => {
    expect(buildRegistryVersionUrl('@scope/pkg', '1.2.3-beta.1')).toBe(
      'https://registry.npmjs.org/%40scope%2Fpkg/1.2.3-beta.1',
    );
  });
});

describe('checkPublishVersion', () => {
  it('passes an abort signal to the registry fetch', async () => {
    const fetchImpl: FetchImpl = vi.fn(() =>
      Promise.resolve(makeRegistryResponse(true, 200, 'OK')),
    );

    await checkPublishVersion({
      packageName: 'cavendish',
      version: '2.1.0',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];

    expect(init?.headers).toEqual({
      accept: 'application/json',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('publishes when the version does not exist yet', async () => {
    const fetchImpl: FetchImpl = vi.fn(() =>
      Promise.resolve(makeRegistryResponse(false, 404, 'Not Found')),
    );

    await expect(
      checkPublishVersion({
        packageName: 'cavendish',
        version: '9.9.9',
        fetchImpl,
      }),
    ).resolves.toEqual({
      shouldPublish: true,
      reason: 'npm does not have cavendish@9.9.9 yet.',
    });
  });

  it('skips publish when the version already exists', async () => {
    const fetchImpl: FetchImpl = vi.fn(() =>
      Promise.resolve(makeRegistryResponse(true, 200, 'OK')),
    );

    await expect(
      checkPublishVersion({
        packageName: 'cavendish',
        version: '2.1.0',
        fetchImpl,
      }),
    ).resolves.toEqual({
      shouldPublish: false,
      reason: 'npm already has cavendish@2.1.0; skipping publish.',
    });
  });

  it('fails when the registry check itself fails', async () => {
    const fetchImpl: FetchImpl = vi.fn(() =>
      Promise.resolve(makeRegistryResponse(false, 500, 'Internal Server Error')),
    );

    await expect(
      checkPublishVersion({
        packageName: 'cavendish',
        version: '2.1.0',
        fetchImpl,
      }),
    ).rejects.toThrow(
      'Failed to check npm registry for cavendish@2.1.0: 500 Internal Server Error',
    );
  });

  it('fails with a timeout error when the registry request hangs', async () => {
    vi.useFakeTimers();

    const fetchImpl: FetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<RegistryResponse>((_, reject: (reason?: unknown) => void) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('The operation was aborted.');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const pending = checkPublishVersion({
      packageName: 'cavendish',
      version: '2.1.0',
      fetchImpl,
      timeoutMs: 10,
    });
    const assertion = expect(pending).rejects.toThrow(
      'Timed out checking npm registry for cavendish@2.1.0 after 10ms',
    );

    await vi.advanceTimersByTimeAsync(10);

    await assertion;

    vi.useRealTimers();
  });
});
