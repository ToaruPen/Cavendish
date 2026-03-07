import { BrowserManager } from './browser-manager.js';
import { ChatGPTDriver } from './chatgpt-driver.js';
import { failStructured } from './output-handler.js';

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
): Promise<void> {
  const browser = new BrowserManager();

  try {
    const page = await browser.getPage(quiet);
    const driver = new ChatGPTDriver(page);
    await action(driver);
  } catch (error: unknown) {
    failStructured(error, format);
  } finally {
    await browser.close();
  }
}
