import fs from "fs";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import os from "os";
import { chromium, Browser, BrowserContext, type Cookie } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const DEFAULT_AUTH_DIR = path.join(os.homedir(), ".google-flow-mcp");
const AUTH_FILE = "auth.json";
const LOGGED_IN_SELECTOR = '[data-slate-editor="true"]';

export class AuthManager {
  private authDir: string;
  private authFilePath: string;
  private currentBrowser: Browser | null = null;

  constructor(authDir?: string) {
    this.authDir = authDir ?? DEFAULT_AUTH_DIR;
    this.authFilePath = path.join(this.authDir, AUTH_FILE);
  }

  hasSavedSession(): boolean {
    return fs.existsSync(this.authFilePath);
  }

  async saveCookies(cookies: Cookie[]): Promise<void> {
    await mkdir(this.authDir, { recursive: true });
    await writeFile(this.authFilePath, JSON.stringify(cookies, null, 2));
  }

  async loadCookies(): Promise<Cookie[] | null> {
    if (!this.hasSavedSession()) return null;
    try {
      const data = await readFile(this.authFilePath, "utf-8");
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return null;
      return parsed as Cookie[];
    } catch {
      return null;
    }
  }

  async launchHeadedForAuth(): Promise<void> {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    console.error("[google-flow-mcp] Browser opened for authentication.");
    console.error("[google-flow-mcp] Please log in with your Google AI Pro account.");
    console.error("[google-flow-mcp] Waiting for successful login...");

    // Wait for the Flow UI to load (prompt editor is visible = logged in)
    await page.waitForSelector(LOGGED_IN_SELECTOR, {
      timeout: 300_000, // 5 minutes to log in
    });

    console.error("[google-flow-mcp] Login detected. Saving session...");

    const cookies = await context.cookies();
    await this.saveCookies(cookies);
    await browser.close();

    console.error("[google-flow-mcp] Session saved. Auth complete.");
  }

  async getAuthenticatedContext(): Promise<BrowserContext> {
    const cookies = await this.loadCookies();

    if (!cookies) {
      await this.launchHeadedForAuth();
      return this.createHeadlessContext();
    }

    const context = await this.createHeadlessContext();

    // Verify session is still valid
    const page = await context.newPage();
    await page.goto(FLOW_URL, { waitUntil: "networkidle" });

    const isLoggedIn = await page
      .waitForSelector(LOGGED_IN_SELECTOR, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!isLoggedIn) {
      console.error("[google-flow-mcp] Session expired. Re-authenticating...");
      await context.browser()!.close();
      await this.launchHeadedForAuth();
      return this.createHeadlessContext();
    }

    // Close the verification page, return context for use
    await page.close();
    return context;
  }

  private async createHeadlessContext(): Promise<BrowserContext> {
    this.currentBrowser = await chromium.launch({ headless: true });
    const context = await this.currentBrowser.newContext();
    const cookies = await this.loadCookies();
    if (cookies) {
      await context.addCookies(cookies);
    }
    return context;
  }

  async close(): Promise<void> {
    if (this.currentBrowser) {
      await this.currentBrowser.close();
      this.currentBrowser = null;
    }
  }
}
