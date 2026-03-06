import { BrowserManager } from './browser-manager.js';
import { ChatGPTDriver } from './chatgpt-driver.js';
import { errorMessage, fail } from './output-handler.js';

/**
 * Shared lifecycle wrapper for commands that need a ChatGPTDriver.
 * Handles browser connection, driver creation, error reporting, and cleanup.
 */
export async function withDriver(
  quiet: boolean,
  action: (driver: ChatGPTDriver) => Promise<void>,
): Promise<void> {
  const browser = new BrowserManager();

  try {
    const page = await browser.getPage(quiet);
    const driver = new ChatGPTDriver(page);
    await driver.waitForReady();
    await action(driver);
  } catch (error: unknown) {
    fail(errorMessage(error));
  } finally {
    await browser.close();
  }
}
