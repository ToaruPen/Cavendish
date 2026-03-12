import { BrowserManager } from './browser-manager.js';
import { ChatGPTDriver } from './chatgpt-driver.js';
import { failStructured, verbose } from './output-handler.js';
import { acquireLock, releaseLock } from './process-lock.js';
import { registerCleanup } from './shutdown.js';

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

  // Register cleanup before getPage() so SIGINT/SIGTERM during page
  // acquisition can still close the tab. closePage() is idempotent —
  // safe to call even when no page has been created yet.
  const unregisterPageCleanup = registerCleanup(async (): Promise<void> => {
    await browser.closePage();
  });

  try {
    verbose('Acquiring process lock...', isVerbose);
    acquireLock();
    verbose('Process lock acquired', isVerbose);
    verbose('Acquiring browser page...', isVerbose);
    const page = await browser.getPage(quiet, options?.permissions ?? [], isVerbose);

    verbose('Creating ChatGPTDriver...', isVerbose);
    const driver = new ChatGPTDriver(page);
    verbose('Driver ready, executing command action...', isVerbose);
    await action(driver);
  } catch (error: unknown) {
    failStructured(error, format);
  } finally {
    try {
      try {
        verbose('Closing tab...', isVerbose);
        await browser.closePage();
      } finally {
        // Unregister AFTER closePage completes — if a signal arrived during
        // closePage, the cleanup callback's redundant close is harmless
        // (closePage is idempotent). Unregistering before closePage would
        // leave a window where the tab leaks on signal.
        unregisterPageCleanup();
        verbose('Closing Playwright connection...', isVerbose);
        await browser.close();
      }
    } finally {
      verbose('Releasing process lock...', isVerbose);
      releaseLock();
      verbose('Cleanup complete', isVerbose);
    }
  }
}
