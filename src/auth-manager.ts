import fs from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import { chromium, BrowserContext } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const AUTH_DIR = path.join(os.homedir(), ".google-flow-mcp");
const PROFILE_DIR = path.join(AUTH_DIR, "chrome-profile");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const LOGGED_IN_SELECTOR = 'button:has-text("New project"), [data-slate-editor="true"]';

// Shared launch args — same for auth and runtime
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,900",
];

export class AuthManager {
  private context: BrowserContext | null = null;

  hasProfile(): boolean {
    return fs.existsSync(PROFILE_DIR);
  }

  // ─── Auth command ────────────────────────────────────────────────────────────
  // Launches a visible browser, waits for the user to sign in,
  // then saves both the persistent profile AND a state.json backup.

  async launchForAuth(): Promise<void> {
    console.error("[google-flow-mcp] Launching Chrome for authentication...");
    console.error("[google-flow-mcp] Sign in with your Google AI Pro account.");

    // Clean up old profile to avoid lock/corruption issues
    await rm(PROFILE_DIR, { recursive: true, force: true });
    await mkdir(PROFILE_DIR, { recursive: true });

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: LAUNCH_ARGS,
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

    // Save state.json backup (cookies + localStorage) alongside the profile
    await this._saveStateBackup(context);

    console.error("[google-flow-mcp] Session saved. Auth complete.");
    await context.close();
  }

  // ─── Runtime context ─────────────────────────────────────────────────────────
  // Uses launchPersistentContext from the saved profile directory.
  // The browser syncs cookies back to disk automatically — no manual refresh needed.
  // Falls back to state.json if the profile is missing (e.g. first run after migration).

  async getAuthenticatedContext(): Promise<BrowserContext> {
    if (!this.hasProfile()) {
      throw new Error(
        "Google Flow session not set up. Run `node dist/index.js auth` to sign in."
      );
    }

    console.error("[google-flow-mcp] Launching persistent browser context...");

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: LAUNCH_ARGS,
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    const isLoggedIn = await page
      .waitForSelector(LOGGED_IN_SELECTOR, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!isLoggedIn) {
      await context.close();
      throw new Error(
        "Google Flow session expired. Run `node dist/index.js auth` to re-authenticate."
      );
    }

    await page.close();

    // Save a fresh state.json backup now that we know the session is valid
    await this._saveStateBackup(context);

    this.context = context;
    return context;
  }

  // ─── State backup ─────────────────────────────────────────────────────────────
  // Saves cookies + localStorage to state.json after every successful auth check.
  // This keeps the backup fresh and makes it easy to inspect or restore manually.

  async saveStateAfterOperation(): Promise<void> {
    if (this.context) {
      await this._saveStateBackup(this.context).catch((e) => {
        console.error("[google-flow-mcp] Warning: failed to save state backup:", e);
      });
    }
  }

  private async _saveStateBackup(context: BrowserContext): Promise<void> {
    try {
      const state = await context.storageState();
      await mkdir(AUTH_DIR, { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
      console.error("[google-flow-mcp] State backup saved.");
    } catch (e) {
      console.error("[google-flow-mcp] Warning: could not save state backup:", e);
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}
