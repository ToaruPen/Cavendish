/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { appendFile, readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{
 *   ok: boolean;
 *   status: number;
 *   statusText: string;
 * }} RegistryResponse
 */

/**
 * @typedef {{
 *   packageName: string;
 *   version: string;
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<RegistryResponse>;
 *   timeoutMs?: number;
 * }} CheckPublishVersionOptions
 */

/**
 * @typedef {{
 *   shouldPublish: boolean;
 *   reason: string;
 * }} PublishDecision
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** @type {(packageName: string, version: string) => string} */
export const buildRegistryVersionUrl = (packageName, version) => {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
};

/** @type {(options: CheckPublishVersionOptions) => Promise<PublishDecision>} */
export const checkPublishVersion = async ({
  packageName,
  version,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetchImpl(buildRegistryVersionUrl(packageName, version), {
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || controller.signal.aborted)
    ) {
      throw new Error(
        `Timed out checking npm registry for ${packageName}@${version} after ${String(timeoutMs)}ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 404) {
    return {
      shouldPublish: true,
      reason: `npm does not have ${packageName}@${version} yet.`,
    };
  }

  if (response.ok) {
    return {
      shouldPublish: false,
      reason: `npm already has ${packageName}@${version}; skipping publish.`,
    };
  }

  throw new Error(
    `Failed to check npm registry for ${packageName}@${version}: ${String(response.status)} ${response.statusText}`,
  );
};

/** @type {() => Promise<{name: string; version: string}>} */
const readPackageMetadata = async () => {
  const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf-8');
  const parsed = /** @type {unknown} */ (JSON.parse(raw));

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'name' in parsed &&
    typeof parsed.name === 'string' &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return {
      name: parsed.name,
      version: parsed.version,
    };
  }

  throw new Error('package.json is missing string name/version fields');
};

/** @type {() => Promise<void>} */
const main = async () => {
  const pkg = await readPackageMetadata();
  const result = await checkPublishVersion({
    packageName: pkg.name,
    version: pkg.version,
  });

  const lines = [
    `should_publish=${result.shouldPublish ? 'true' : 'false'}`,
    `reason=${result.reason}`,
  ];

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await appendFile(outputPath, `${lines.join('\n')}\n`, 'utf-8');
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }

  console.log(result.reason);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(
    /** @type {(error: unknown) => void} */ ((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }),
  );
}
