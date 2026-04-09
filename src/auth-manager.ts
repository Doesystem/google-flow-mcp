import fs from "fs";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import os from "os";
import { chromium, BrowserContext } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const AUTH_DIR = path.join(os.homedir(), ".google-flow-mcp");
const PROFILE_DIR = path.join(AUTH_DIR, "chrome-profile");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const LOCK_FILE = path.join(PROFILE_DIR, "SingletonLock");
const LOGGED_IN_SELECTOR = 'button:has-text("New project"), [data-slate-editor="true"]';

const AUTOMATION_FLAGS = [
  "--enable-automation",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--no-first-run",
];

function clearStaleLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch { /* ignore */ }
}

export class AuthManager {
  private browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  private context: BrowserContext | null = null;

  hasSavedState(): boolean {
    return fs.existsSync(STATE_FILE);
  }

  async launchForAuth(): Promise<void> {
    console.error("[google-flow-mcp] Launching Chrome for authentication...");
    console.error("[google-flow-mcp] Sign in with your Google AI Pro account.");

    await mkdir(AUTH_DIR, { recursive: true });
    clearStaleLock();

    // Use persistent context with real Chrome for auth only
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      ignoreDefaultArgs: AUTOMATION_FLAGS,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    console.error("[google-flow-mcp] Waiting for login (5 min timeout)...");
    await page.waitForSelector(LOGGED_IN_SELECTOR, { timeout: 300_000 });

    // Save session state (cookies + localStorage) to a file
    const state = await context.storageState();
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

    console.error("[google-flow-mcp] Session saved. Auth complete.");
    await context.close();
  }

  async getAuthenticatedContext(): Promise<BrowserContext> {
    if (!this.hasSavedState()) {
      throw new Error(
        "Google Flow session not set up. Run `npx google-flow-mcp auth` to sign in."
      );
    }

    // Load saved state into a regular (non-persistent) browser — no locks, no conflicts
    const state = JSON.parse(await readFile(STATE_FILE, "utf-8"));

    this.browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      ignoreDefaultArgs: AUTOMATION_FLAGS,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    this.context = await this.browser!.newContext({ storageState: state });

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
      await this.browser!.close();
      this.context = null;
      throw new Error(
        "Google Flow session expired. Run `npx google-flow-mcp auth` to re-authenticate."
      );
    }

    await page.close();
    return this.context;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser!.close();
      this.context = null;
    }
  }
}
