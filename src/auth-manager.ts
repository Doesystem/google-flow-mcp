import fs from "fs";
import path from "path";
import os from "os";
import { chromium, BrowserContext } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const PROFILE_DIR = path.join(os.homedir(), ".google-flow-mcp", "chrome-profile");
// Flow now lands on a project dashboard when logged in
const LOGGED_IN_SELECTOR = 'button:has-text("New project"), [data-slate-editor="true"]';

// Playwright injects these flags which Google uses to detect automation
const AUTOMATION_FLAGS = [
  "--enable-automation",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--no-first-run",
];

function launchOptions(headless: boolean) {
  return {
    channel: "chrome" as const,
    headless,
    ignoreDefaultArgs: AUTOMATION_FLAGS,
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  };
}

export class AuthManager {
  private context: BrowserContext | null = null;

  hasProfile(): boolean {
    return fs.existsSync(PROFILE_DIR);
  }

  async launchForAuth(): Promise<void> {
    console.error("[google-flow-mcp] Launching Chrome for authentication...");
    console.error("[google-flow-mcp] Please sign in with your Google AI Pro account.");

    const context = await chromium.launchPersistentContext(
      PROFILE_DIR,
      launchOptions(false)
    );

    // Remove navigator.webdriver flag that Google checks
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    console.error("[google-flow-mcp] Waiting for successful login (5 min timeout)...");

    await page.waitForSelector(LOGGED_IN_SELECTOR, { timeout: 300_000 });

    console.error("[google-flow-mcp] Login detected. Session saved to Chrome profile.");
    await context.close();
    console.error("[google-flow-mcp] Auth complete. You can now use the MCP server.");
  }

  async getAuthenticatedContext(): Promise<BrowserContext> {
    if (!this.hasProfile()) {
      throw new Error(
        "Google Flow session not set up. Run `npx google-flow-mcp auth` to sign in."
      );
    }

    this.context = await chromium.launchPersistentContext(
      PROFILE_DIR,
      launchOptions(true)
    );

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = this.context.pages()[0] ?? await this.context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    const isLoggedIn = await page
      .waitForSelector(LOGGED_IN_SELECTOR, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!isLoggedIn) {
      await this.context.close();
      this.context = null;
      throw new Error(
        "Google Flow session expired. Run `npx google-flow-mcp auth` to re-authenticate."
      );
    }

    await page.close();
    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}
