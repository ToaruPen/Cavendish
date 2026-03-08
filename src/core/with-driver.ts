import { BrowserManager } from './browser-manager.js';
import { ChatGPTDriver } from './chatgpt-driver.js';
import { failStructured, verbose } from './output-handler.js';

export interface WithDriverOptions {
  /** Browser permissions to grant for the ChatGPT origin (default: none). */
  permissions?: string[];
  /** Enable verbose diagnostic output (default: false). */
  verbose?: boolean;
}

/**
 * Shared lifecycle wrapper for commands that need a ChatGPTDriver.
 * Handles browser connection, driver creation, error reporting, and cleanup.
 *
 * Errors are classified into structured categories with distinct exit codes.
 * When `format` is `'json'`, the error is written to stderr as JSON.
 */
export async function withDriver(
  quiet: boolean,
  action: (driver: ChatGPTDriver) => Promise<void>,
  format?: 'json' | 'text',
  options?: WithDriverOptions,
): Promise<void> {
  const isVerbose = options?.verbose ?? false;
  const browser = new BrowserManager();

  try {
    verbose('Acquiring browser page...', isVerbose);
    const page = await browser.getPage(quiet, options?.permissions ?? [], isVerbose);
    verbose('Creating ChatGPTDriver...', isVerbose);
    const driver = new ChatGPTDriver(page);
    verbose('Driver ready, executing command action...', isVerbose);
    await action(driver);
  } catch (error: unknown) {
    failStructured(error, format);
  } finally {
    verbose('Closing Playwright connection...', isVerbose);
    await browser.close();
    verbose('Cleanup complete', isVerbose);
  }
}
