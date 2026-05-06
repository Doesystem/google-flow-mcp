import fs from "fs";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import { chromium, BrowserContext } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const AUTH_DIR = path.join(os.homedir(), ".google-flow-mcp");
const PROFILE_DIR = path.join(AUTH_DIR, "chrome-profile");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const LOGGED_IN_SELECTOR = 'button:has-text("New project"), [data-slate-editor="true"]';

export class AuthManager {
  private browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  private context: BrowserContext | null = null;

  hasSavedState(): boolean {
    return fs.existsSync(STATE_FILE);
  }

  async launchForAuth(): Promise<void> {
    console.error("[google-flow-mcp] Launching Chrome for authentication...");
    console.error("[google-flow-mcp] Sign in with your Google AI Pro account.");

    // Clean up old profile to avoid lock/corruption issues
    await rm(PROFILE_DIR, { recursive: true, force: true });
    await mkdir(PROFILE_DIR, { recursive: true });

    // Use persistent context so Google login works properly
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = context.pages()[0] ?? await context.newPage();

    console.error("[google-flow-mcp] Opening Google Flow...");
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    console.error("[google-flow-mcp] Waiting for login (5 min timeout)...");
    console.error("[google-flow-mcp] Please sign in with your Google AI Pro account in the browser window.");
    await page.waitForSelector(LOGGED_IN_SELECTOR, { timeout: 300_000 });

    // Save session state (cookies + localStorage)
    const state = await context.storageState();
    await mkdir(AUTH_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

    console.error("[google-flow-mcp] Session saved. Auth complete.");
    await context.close();
  }

  async getAuthenticatedContext(): Promise<BrowserContext> {
    if (!this.hasSavedState()) {
      throw new Error(
        "Google Flow session not set up. Run `node dist/index.js auth` to sign in."
      );
    }

    const state = JSON.parse(await readFile(STATE_FILE, "utf-8"));

    // headless: false with off-screen window — required for Slate editor input to work
    this.browser = await chromium.launch({
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
      ],
    });

    this.context = await this.browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await this.context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    const isLoggedIn = await page
      .waitForSelector(LOGGED_IN_SELECTOR, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!isLoggedIn) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      throw new Error(
        "Google Flow session expired. Run `node dist/index.js auth` to re-authenticate."
      );
    }

    await page.close();
    return this.context;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }
}
