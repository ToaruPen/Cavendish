import { describe, expect, it, vi } from 'vitest';

import {
  buildRegistryVersionUrl,
  checkPublishVersion,
} from '../.github/scripts/check-publish-version.mjs';

describe('buildRegistryVersionUrl', () => {
  it('encodes scoped package names and versions', () => {
    expect(buildRegistryVersionUrl('@scope/pkg', '1.2.3-beta.1')).toBe(
      'https://registry.npmjs.org/%40scope%2Fpkg/1.2.3-beta.1',
    );
  });
});

describe('checkPublishVersion', () => {
  it('publishes when the version does not exist yet', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }));

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
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));

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
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

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
});
